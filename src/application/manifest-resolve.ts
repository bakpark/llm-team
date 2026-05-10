import { createHash } from "node:crypto";
import type { ContextManifest, ManifestEntry } from "../domain/schema/manifest.js";
import type { StorePort } from "../ports/store.js";
import { Milestone } from "../domain/schema/milestone.js";
import { FeatureRequest } from "../domain/schema/feature-request.js";
import { SessionTurn } from "../domain/schema/session-turn.js";
import { Slice } from "../domain/schema/slice.js";
import { SliceMerge } from "../domain/schema/slice-merge.js";
import { VerificationRun } from "../domain/schema/verification.js";
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
 * Scope (incident-1b minimum + incident-5):
 *   - `milestone` + `body` — load `milestones/<id>.json`, render title + intake
 *     source body (when the intake source is a `feature_request` we fetch the
 *     `feature_requests/<id>.json` body). Optionally append `milestones/<id>/spec.md`
 *     when present.
 *   - `session_turn` + `body` — incident-5: load
 *     `sessions/<session_id>/turns/<turn_index>.json` and project the
 *     agent-relevant subset under `# Inputs` so prior reviewer rationales
 *     reach the next lead/reviewer (breaks the
 *     `request_changes ↔ need_context` Discovery loop).
 *   - `slice` + `body` — incident-9: load `slices/<slice_id>.json` and
 *     project the agent-relevant subset (slice_id, slice_kind,
 *     value_statement, ac_ids, acceptance_tests, declared_scope,
 *     dependencies, state, dod_revision_pin, trunk_base_revision) so the
 *     inner TDD `forge` agent can author patches instead of looping on
 *     `failure: need_context`. Revision pin is matched by equality with
 *     `slice.dod_revision_pin` (a logical marker like `selfhost-dod-v1`,
 *     not a SHA — consistent with `SliceLocalPinResolver` in turn-worker).
 *   - Other (object_kind, fetch_scope) combinations throw an explicit
 *     "unsupported" error. The caller decides:
 *       - `required=true` → surface the error (caller turns into AGC-INVALID),
 *       - `required=false` → skip silently (entry omitted from `# Inputs`,
 *         prompt still renders so the agent can decide).
 *
 * TODO(incident-6+): slice / slice_merge / dialogue_session / verification_run
 * resolvers — separate cycle. turn-worker (inner loop) and
 * dialogue-coordinator (middle loop) currently DO NOT wire `StorePort` into
 * `resolveManifestEntries`; only outer-turn does. Inner/middle loops still
 * inline their own (slice, body) reads via composePrompt's legacy path until
 * those resolvers exist here.
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
  if (entry.object_kind === "slice" && entry.fetch_scope === "body") {
    return resolveSliceBody(store, entry);
  }
  if (entry.object_kind === "slice_merge" && entry.fetch_scope === "body") {
    return resolveSliceMergeBody(store, entry);
  }
  if (entry.object_kind === "verification_run" && entry.fetch_scope === "body") {
    return resolveVerificationRunBody(store, entry);
  }
  // Other (kind, scope) pairs remain out of scope. For `required=true`
  // entries the resolver throws so the caller can surface an AGC-INVALID
  // outcome (no silent empty prompt). For non-required entries the caller
  // catches and skips (entry omitted from `# Inputs`). Future work can
  // extend this switch with dialogue_session resolution.
  if (entry.required) {
    throw new UnsupportedManifestEntryError(
      entry,
      "resolver supports (milestone, body), (session_turn, body), (slice, body), (slice_merge, body), (verification_run, body) only",
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
 * full-body `sha256(raw)` hex (PR #96 P0-1 — replaces the original
 * `len=<n>:<first 32 chars>` form, which silently passed when post-prefix
 * fields like summary/verdict.rationale/failure/next_action_request changed
 * without altering body length). Mismatches surface StaleManifestEntryError
 * for required entries (mirrors milestone body).
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
  // PR #96 P0-1: full-body sha256 hex. The previous `len=N:<first 32 chars>`
  // form missed mutations in summary / verdict.rationale / failure /
  // next_action_request when the new body happened to be the same length,
  // letting a stale-context turn pass the gate.
  const expectedPin = createHash("sha256").update(raw).digest("hex");
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

/**
 * incident-9 — resolve `(slice, body)` so the inner TDD `forge` agent can
 * read its primary input (slice scope, AC list, declared_scope,
 * dod_revision_pin, trunk_base_revision) inline under `# Inputs` instead
 * of returning `failure: need_context` because the body section reports
 * `BODY NOT INLINED`.
 *
 * Layout: `slices/<slice_id>.json` (see `persistence-layout.ts`).
 *
 * Revision pin: equality with `slice.dod_revision_pin`. Unlike milestone
 * (`updated_at`) and session_turn (full-body sha256) pins which are
 * content-derived, the slice pin is a LOGICAL marker authored by the
 * outer/middle loops (e.g. `selfhost-dod-v1`) and stored on the slice
 * record itself. `SliceLocalPinResolver` in `turn-worker.ts` uses the
 * same `slice.dod_revision_pin` to populate the manifest pin, so a match
 * is the correct freshness check. Mismatches surface
 * `StaleManifestEntryError` for required entries (mirrors milestone /
 * session_turn body).
 *
 * Projection: agent-relevant subset only. The full Slice record contains
 * caller/lease metadata (`current_session_id`, `spawning_proposal_id`,
 * `abandoned_reason`, `external_refs`, timestamps) that don't help
 * `forge` author the patch.
 */
async function resolveSliceBody(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  const path = layout.slice(entry.object_id);
  const raw = await store.readText(path);
  if (raw == null) {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  let slice: ReturnType<typeof Slice.parse>;
  try {
    slice = Slice.parse(JSON.parse(raw));
  } catch {
    // Persisted file is corrupt / not a Slice; treat as missing.
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  // Revision-pin check — equality with `slice.dod_revision_pin` (logical
  // marker, not content hash). See doc comment above for rationale.
  if (slice.dod_revision_pin !== entry.revision_pin) {
    if (entry.required) {
      throw new StaleManifestEntryError(entry, slice.dod_revision_pin);
    }
    return null;
  }
  const projection: Record<string, unknown> = {
    slice_id: slice.slice_id,
    slice_kind: slice.slice_kind,
    value_statement: slice.value_statement,
    ac_ids: slice.ac_ids,
    acceptance_tests: slice.acceptance_tests,
    declared_scope: slice.declared_scope,
    dependencies: slice.dependencies,
    state: slice.state,
    dod_revision_pin: slice.dod_revision_pin,
    trunk_base_revision: slice.trunk_base_revision,
  };
  return JSON.stringify(projection, null, 2);
}

/**
 * incident-11 — resolve `(slice_merge, body)` so the middle review sentinel
 * (and scout) can read the SliceMerge record (the review subject) inline
 * under `# Inputs` instead of seeing `[BODY NOT INLINED]` and emitting
 * `failure: need_context`.
 *
 * Layout: `slice_merges/<slice_merge_id>.json`.
 *
 * Revision pin: equality with `sliceMerge.pre_merge_workspace_revision`,
 * falling back to `sliceMerge.slice_merge_id` when the pre-merge revision is
 * null. This mirrors `MiddleReviewPinResolver` in `dialogue-coordinator.ts`,
 * which is the authoring side of these manifest entries — both sides must
 * agree or the resolver rejects fresh entries as stale.
 */
async function resolveSliceMergeBody(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  const path = layout.sliceMerge(entry.object_id);
  const raw = await store.readText(path);
  if (raw == null) {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  let sliceMerge: ReturnType<typeof SliceMerge.parse>;
  try {
    sliceMerge = SliceMerge.parse(JSON.parse(raw));
  } catch {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  // Revision pin matches MiddleReviewPinResolver:
  //   sliceMerge.pre_merge_workspace_revision ?? sliceMerge.slice_merge_id
  const expectedPin =
    sliceMerge.pre_merge_workspace_revision ?? sliceMerge.slice_merge_id;
  if (expectedPin !== entry.revision_pin) {
    if (entry.required) {
      throw new StaleManifestEntryError(entry, expectedPin);
    }
    return null;
  }
  // Project review-relevant fields. Caller / lease metadata
  // (lease_token, merged_by_caller_id, audit_chain_predecessor_id,
  // external_refs, timestamps) does not help reviewers decide.
  const projection: Record<string, unknown> = {
    slice_merge_id: sliceMerge.slice_merge_id,
    slice_id: sliceMerge.slice_id,
    target_id: sliceMerge.target_id,
    state: sliceMerge.state,
    pre_merge_workspace_revision: sliceMerge.pre_merge_workspace_revision,
    merge_revision: sliceMerge.merge_revision,
    inner_session_id: sliceMerge.inner_session_id,
    review_session_id: sliceMerge.review_session_id,
    verification_run_id: sliceMerge.verification_run_id,
    merged_at: sliceMerge.merged_at,
  };
  return JSON.stringify(projection, null, 2);
}

/**
 * incident-11 — resolve `(verification_run, body)` so the middle review
 * sentinel can read the deterministic-evidence record inline under
 * `# Inputs` instead of seeing `[BODY NOT INLINED]`.
 *
 * Layout: `verifications/<verification_run_id>.json` (see
 * `persistence-layout.ts` — function name is `layout.verification`).
 *
 * Revision pin: equality with `entry.object_id` (i.e. the
 * verification_run_id itself). Mirrors `MiddleReviewPinResolver` in
 * `dialogue-coordinator.ts` which sets the manifest pin to
 * `entry.object_id` for verification_run entries — VerificationRun records
 * are immutable evidence so the ID is the freshness marker.
 */
async function resolveVerificationRunBody(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  const path = layout.verification(entry.object_id);
  const raw = await store.readText(path);
  if (raw == null) {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  let run: ReturnType<typeof VerificationRun.parse>;
  try {
    run = VerificationRun.parse(JSON.parse(raw));
  } catch {
    if (entry.required) {
      throw new MissingRequiredManifestEntryError(entry, path);
    }
    return null;
  }
  // Pin equality with the verification_run_id itself (immutable evidence).
  if (run.verification_run_id !== entry.revision_pin) {
    if (entry.required) {
      throw new StaleManifestEntryError(entry, run.verification_run_id);
    }
    return null;
  }
  // Project review-relevant fields. The schema has no stdout/stderr —
  // log_ref points off-record when present. Include result + failed_tests
  // so the reviewer can see exactly which AC-bound tests failed.
  const projection: Record<string, unknown> = {
    verification_run_id: run.verification_run_id,
    target_id: run.target_id,
    target_revision: run.target_revision,
    commands_or_checks: run.commands_or_checks,
    result: run.result,
    failed_tests: run.failed_tests,
    covers_ac_ids: run.covers_ac_ids,
    log_ref: run.log_ref,
  };
  return JSON.stringify(projection, null, 2);
}
