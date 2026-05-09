import { z } from "zod";

/**
 * `kind` covers the abstract slots in `external-tracking-mapping.md` §1.
 * Phase 6b adds `milestone_tracker`, `control`, `contract_change` so the
 * GitHub adapter can mirror the governance issues described in
 * `github-side-effect-timeline.md` Repo Bootstrap.
 */
export const ExternalRefKind = z.enum([
  "tracker",
  "review_surface",
  "milestone",
  "milestone_tracker",
  "control",
  "contract_change",
  "unknown",
]);
export type ExternalRefKind = z.infer<typeof ExternalRefKind>;

/**
 * `sync_status` enum follows external-tracking-mapping.md §5.1.
 *
 * `clean` is preserved as an alias for `synced` for legacy persisted rows;
 * new writers must use `synced`.
 */
export const ExternalRefSyncStatus = z.enum([
  "synced",
  "clean", // legacy alias, deprecated; new code uses "synced"
  "dirty",
  "conflict",
  "orphan",
  "unknown",
]);
export type ExternalRefSyncStatus = z.infer<typeof ExternalRefSyncStatus>;

export const ExternalRef = z
  .object({
    provider: z.string().min(1),
    kind: ExternalRefKind,
    id: z.string().min(1),
    url: z.string().min(1).optional(),
    sync_status: ExternalRefSyncStatus.optional(),
    last_synced_internal_revision: z.string().min(1).optional(),
    last_seen_external_revision: z.string().min(1).optional(),
    last_synced_at: z.string().datetime().optional(),
    last_sync_attempt_at: z.string().datetime().optional(),
    last_sync_error: z.string().min(1).optional(),
  })
  .strict();

export type ExternalRef = z.infer<typeof ExternalRef>;
