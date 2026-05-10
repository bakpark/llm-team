import type { ContextManifest, ManifestEntry } from "../domain/schema/manifest.js";
import type { StorePort } from "../ports/store.js";
import { Milestone } from "../domain/schema/milestone.js";
import { FeatureRequest } from "../domain/schema/feature-request.js";
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
  // Other (kind, scope) pairs are out of scope for incident-1b. For
  // `required=true` entries the resolver throws so the caller can surface an
  // AGC-INVALID outcome (no silent empty prompt). For non-required entries
  // the caller catches and skips (entry omitted from `# Inputs`). Future work
  // can extend this switch with slice / slice_merge / dialogue_session /
  // session_turn / verification_run resolution.
  if (entry.required) {
    throw new UnsupportedManifestEntryError(
      entry,
      "resolver supports only (milestone, body) at incident-1b minimum",
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
