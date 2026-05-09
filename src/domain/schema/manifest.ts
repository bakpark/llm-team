import { z } from "zod";
import { UlidString } from "../ids.js";

/**
 * AGC-CONTEXT-MANIFEST schema.
 *
 * Caller-issued ids (manifest_id, session_id) are ULID. `target.object_id`
 * is also Caller-issued so it must be ULID. Per-entry `object_id` is loose
 * (`z.string().min(1)`) because entries may reference external artefacts
 * (e.g. `code_tree` whose id is a branch path, or external mirror payloads).
 */

export const FetchScope = z.enum([
  "metadata",
  "body",
  "tree",
  "body+comments",
  "body+turn_log",
]);
export type FetchScope = z.infer<typeof FetchScope>;

export const ManifestEntryObjectKind = z.enum([
  "milestone",
  "slice",
  "slice_merge",
  "dialogue_session",
  "session_turn",
  "verification_run",
  "metric_run",
  "refactor_proposal",
  "spec_doc",
  "code_tree",
  "context_summary",
  "decision",
  // KAC-SLICE-TELEMETRY (phase 8b) — Discovery N+1 manifest entry that
  // references the latest SliceTelemetry of the live Delivery N. Read-only
  // by contract; the entry's `revision_pin` is the SliceTelemetry's
  // `audit_hash`, which RGC-CROSS-SLOT-STALE compares to detect drift.
  "slice_telemetry",
]);
export type ManifestEntryObjectKind = z.infer<typeof ManifestEntryObjectKind>;

export const ManifestEntry = z
  .object({
    object_kind: ManifestEntryObjectKind,
    object_id: z.string().min(1),
    fetch_scope: FetchScope,
    revision_pin: z.string().min(1),
    required: z.boolean(),
    purpose: z.string().min(1),
    /**
     * AGC-CONTEXT-BUDGET / TCC-CONTEXT-BUDGET — deterministic token-cost
     * forecast used by `application/prompt-compose.ts` to apply the
     * `(parent_loop, phase_or_purpose)` cap before the 1-shot LLM call. The
     * estimate is computed by `application/manifest-builder.ts` from a
     * char/4 heuristic over the entry's serialized header (no body fetch is
     * required at manifest-build time). Optional for backward compatibility
     * with manifests created before phase 8a.
     */
    token_estimate: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const ManifestPurpose = z.enum([
  "design",
  "build",
  "review",
  "tdd_build",
  "planning_decompose",
  "validation",
]);
export type ManifestPurpose = z.infer<typeof ManifestPurpose>;

export const ManifestTargetKind = z.enum([
  "milestone",
  "slice",
  "slice_merge",
]);
export type ManifestTargetKind = z.infer<typeof ManifestTargetKind>;

export const ManifestTarget = z
  .object({
    object_kind: ManifestTargetKind,
    object_id: UlidString,
  })
  .strict();
export type ManifestTarget = z.infer<typeof ManifestTarget>;

export const ContextManifest = z
  .object({
    manifest_id: UlidString,
    session_id: UlidString,
    turn_index: z.number().int().nonnegative(),
    purpose: ManifestPurpose,
    target: ManifestTarget,
    entries: z.array(ManifestEntry).default(() => []),
    created_at: z.string().datetime(),
  })
  .strict();
export type ContextManifest = z.infer<typeof ContextManifest>;
