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
