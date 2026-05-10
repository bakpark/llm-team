import type { ContextManifest, ManifestEntry } from "../domain/schema/manifest.js";
import type { StorePort } from "../ports/store.js";
import { Milestone } from "../domain/schema/milestone.js";
import { FeatureRequest } from "../domain/schema/feature-request.js";
import { SessionTurn } from "../domain/schema/session-turn.js";
import { layout } from "./persistence-layout.js";

/**
 * Manifest body resolution layer (incident-1b Bug B).
 *
 * `composePrompt` inlines the manifest header JSON but never the bodies the
 * entries reference. Without this resolution layer the LLM correctly refused
 * to fabricate scope (Discovery atlas turn 0 returned `failure.need_context`).
 *
 * `resolveManifestEntries` walks each entry, fetches the body via
 * `StorePort` according to (object_kind, fetch_scope), and returns a parallel
 * list of `ResolvedEntry` records that the prompt composer renders verbatim
 * under a new `# Inputs` section.
 *
 * Scope (incident-1b minimal):
 *   - `milestone` + `body` — load `milestones/<id>.json`, render title + intake
 *     source body (when the intake source is a `feature_request` we fetch the
 *     `feature_requests/<id>.json` body). Optionally append `milestones/<id>/spec.md`
 *     when present.
 *   - Other (object_kind, fetch_scope) combinations throw an explicit
 *     "unsupported" error. The caller decides:
 *       - `required=true` → surface the error (caller turns into AGC-INVALID),
 *       - `required=false` → skip silently (entry omitted from `# Inputs`,
 *         prompt still renders so the agent can decide).
 *
 * Caller is `agent-io.callAgent` via the new optional `store` dep.
 */

export interface ResolvedEntry {
  /** 0-based index into `manifest.entries` — preserves ordering for rendering. */
  manifest_entry_index: number;
  body: string;
}

export interface ResolveOptions {
  /**
   * If true, throws when an entry cannot be resolved AND `entry.required`. When
   * false, the entry is simply omitted from the result. Default: true.
   */
  strict?: boolean;
}

class UnsupportedManifestEntryError extends Error {
  constructor(entry: ManifestEntry, hint: string) {
    super(
      `unsupported manifest entry: object_kind=${entry.object_kind} fetch_scope=${entry.fetch_scope} object_id=${entry.object_id} (${hint})`,
    );
  }
}

class MissingRequiredManifestEntryError extends Error {
  constructor(entry: ManifestEntry, path: string) {
    super(
      `required manifest entry not found in store: object_kind=${entry.object_kind} object_id=${entry.object_id} fetch_scope=${entry.fetch_scope} (path=${path})`,
    );
  }
}

class StaleManifestEntryError extends Error {
  constructor(entry: ManifestEntry, actual: string) {
    super(
      `manifest entry revision_pin mismatch: object_kind=${entry.object_kind} object_id=${entry.object_id} declared=${entry.revision_pin} actual=${actual}`,
    );
  }
}

export async function resolveManifestEntries(
  store: StorePort,
  manifest: ContextManifest,
  options: ResolveOptions = {},
): Promise<ResolvedEntry[]> {
  const strict = options.strict ?? true;
  const out: ResolvedEntry[] = [];
  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i]!;
    try {
      const body = await resolveEntry(store, entry);
      if (body != null) out.push({ manifest_entry_index: i, body });
    } catch (e) {
      if (strict && entry.required) throw e;
      // non-required → skip; the prompt will render a sentinel placeholder
    }
  }
  return out;
}

async function resolveEntry(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  if (entry.object_kind === "milestone" && entry.fetch_scope === "body") {
    return resolveMilestoneBody(store, entry);
  }
  if (entry.object_kind === "session_turn" && entry.fetch_scope === "body") {
    return resolveSessionTurnBody(store, entry);
  }
  // Other (kind, scope) pairs remain out of scope. For `required=true`
  // entries the resolver throws so the caller can surface an AGC-INVALID
  // outcome (no silent empty prompt). For non-required entries the caller
  // catches and skips (entry omitted from `# Inputs`). Future work can
  // extend this switch with slice / slice_merge / dialogue_session /
  // verification_run resolution.
  if (entry.required) {
    throw new UnsupportedManifestEntryError(
      entry,
      "resolver supports (milestone, body) and (session_turn, body) only",
    );
  }
  return null;
}

async function resolveMilestoneBody(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  const milestoneId = entry.object_id;
  const milestonePath = layout.milestone(milestoneId);
  const raw = await store.readText(milestonePath);
  if (raw == null) {
    // Required missing-store object MUST surface an explicit error so callers
    // (callAgent) emit a `prompt_compose` AGC-INVALID outcome instead of
    // silently dropping the entry and invoking the LLM with an empty body.
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, milestonePath);
    }
    return null;
  }
  const milestone = Milestone.parse(JSON.parse(raw));
  // RGC-CROSS-SLOT-STALE: the manifest-time pin must match the store's actual
  // revision identifier; otherwise the resolved body is stale relative to the
  // manifest header and would produce a grounded-context contradiction. For
  // milestone bodies the revision identifier is `updated_at`. Required
  // entries surface an error; non-required entries are silently skipped.
  if (milestone.updated_at !== entry.revision_pin) {
    if (entry.required) {
      throw new StaleManifestEntryError(entry, milestone.updated_at);
    }
    return null;
  }
  const sections: string[] = [`title: ${milestone.title}`];

  // Intake source body — feature_request currently the only kind in production.
  if (milestone.intake_source_kind === "feature_request") {
    const frRaw = await store.readText(layout.featureRequest(milestone.intake_source_id));
    if (frRaw != null) {
      const fr = FeatureRequest.parse(JSON.parse(frRaw));
      sections.push(`intake_source (feature_request ${fr.request_id}):\n${fr.body}`);
    }
  }

  // Optional approved spec body (M_SPEC_APPROVED onward).
  const specRaw = await store.readText(layout.milestoneSpec(milestoneId));
  if (specRaw != null && specRaw.length > 0) {
    sections.push(`spec.md:\n${specRaw}`);
  }

  return sections.join("\n\n");
}

/**
 * incident-5 — resolve `(session_turn, body)` so Discovery atlas/sentinel
 * can read prior turn rationales (especially reviewer `request_changes`)
 * inline under `# Inputs` instead of looping forever in
 * `request_changes ↔ need_context`.
 *
 * Layout: `sessions/<session_id>/turns/<turn_index>.json`. The persisted
 * body is a SessionTurn record; we render only the agent-relevant fields
 * (agent_profile_id, role, output_kind, summary, verdict, failure,
 * next_action_request) so the prompt stays bounded — the full record can
 * include adapter trace metadata that does not help the next turn.
 *
 * `entry.turn_index` is the new schema field (also pre-incident-5
 * manifests embedded the index in `object_id` as `${session_id}#${i}`;
 * we fall back to that legacy form so any in-flight manifest still
 * resolves).
 *
 * Revision pin matches OuterPinResolver's session_turn fingerprint:
 * `len=<bodyLength>:<first 32 non-whitespace chars>`. Mismatches surface
 * StaleManifestEntryError for required entries (mirrors milestone body).
 */
async function resolveSessionTurnBody(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  const sessionId = entry.object_id.includes("#")
    ? entry.object_id.split("#")[0]!
    : entry.object_id;
  const turnIndex =
    entry.turn_index ??
    (entry.object_id.includes("#")
      ? Number.parseInt(entry.object_id.split("#")[1]!, 10)
      : NaN);
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    if (entry.required) {
      throw new UnsupportedManifestEntryError(
        entry,
        "session_turn entry must carry turn_index (or legacy ${session_id}#${i} object_id)",
      );
    }
    return null;
  }
  const path = layout.sessionTurn(sessionId, turnIndex);
  const raw = await store.readText(path);
  if (raw == null) {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  // Revision-pin check — must agree with OuterPinResolver.session_turn
  // fingerprint format. Stale ⇒ throw for required, skip for non-required.
  const expectedPin = `len=${raw.length}:${raw.slice(0, 32).replace(/\s+/g, "")}`;
  if (expectedPin !== entry.revision_pin) {
    if (entry.required) {
      throw new StaleManifestEntryError(entry, expectedPin);
    }
    return null;
  }
  let turn: ReturnType<typeof SessionTurn.parse>;
  try {
    turn = SessionTurn.parse(JSON.parse(raw));
  } catch {
    // Persisted file is corrupt / not a SessionTurn; treat as missing.
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  const env = turn.output_envelope;
  // Project the agent-relevant subset; full envelope can include adapter
  // metadata that does not help the next turn. Keep deterministic key
  // ordering for stable prompt diffs.
  const projection: Record<string, unknown> = {
    session_id: turn.session_id,
    turn_index: turn.turn_index,
    agent_profile_id: turn.agent_profile_id,
    agent_role_in_session: env.agent_role_in_session,
    output_kind: env.output_kind,
    contribution_kind: env.contribution_kind,
    summary: env.summary,
    verdict: env.verdict,
    failure: env.failure,
    next_action_request: env.next_action_request,
  };
  return JSON.stringify(projection, null, 2);
}
