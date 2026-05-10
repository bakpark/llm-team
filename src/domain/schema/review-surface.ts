import { z } from "zod";
import { UlidString } from "../ids.js";

/**
 * ReviewSurface — provider-agnostic, parent-agnostic surface backing a
 * single PR for a slice / milestone / spec_doc.
 *
 * Authority: `cli-spicy-anchor.md` §2.
 *
 * Phase 1 introduces the schema only. Caller-side write paths (lead-invoker /
 * reviewer-invoker, recovery-coordinator) land in Phase 2/3.
 */

export const ReviewSurfaceParentKind = z.enum([
  "slice",
  "milestone",
  "spec_doc",
]);
export type ReviewSurfaceParentKind = z.infer<typeof ReviewSurfaceParentKind>;

/**
 * `parent_phase` is meaningful only when `parent_kind=milestone`. For
 * slice / spec_doc the field is `null`.
 */
export const ReviewSurfaceParentPhase = z.enum([
  "Discovery",
  "Specification",
  "Planning",
  "Validation",
]);
export type ReviewSurfaceParentPhase = z.infer<
  typeof ReviewSurfaceParentPhase
>;

export const ReviewSurfaceLifecycleState = z.enum([
  "open",
  "merged",
  "closed",
  "externally_closed",
]);
export type ReviewSurfaceLifecycleState = z.infer<
  typeof ReviewSurfaceLifecycleState
>;

export const ReviewSurfaceReviewState = z.enum([
  "pending_review",
  "changes_requested",
  "approved",
]);
export type ReviewSurfaceReviewState = z.infer<
  typeof ReviewSurfaceReviewState
>;

export const ReviewSurfaceBuildState = z.enum([
  "ready",
  "rebuilding",
  "stale",
  "not_applicable",
]);
export type ReviewSurfaceBuildState = z.infer<typeof ReviewSurfaceBuildState>;

export const ReviewSurfacePrRef = z
  .object({
    provider: z.enum(["github", "fs_mirror"]),
    /** Provider-local execution identifier (GitHub: PR number string). */
    id: z.string().min(1),
    /** Optional GraphQL node id. */
    node_id: z.string().min(1).nullable().default(null),
    url: z.string().min(1),
  })
  .strict();
export type ReviewSurfacePrRef = z.infer<typeof ReviewSurfacePrRef>;

export const ReviewSurface = z
  .object({
    review_surface_id: UlidString,
    parent_kind: ReviewSurfaceParentKind,
    parent_id: UlidString,
    /** Required only when parent_kind=milestone. Null otherwise. */
    parent_phase: ReviewSurfaceParentPhase.nullable().default(null),
    pr_ref: ReviewSurfacePrRef,
    branch: z.string().min(1),
    base_ref: z.string().min(1),
    head_sha: z.string().min(1),
    review_round: z.number().int().nonnegative(),
    lifecycle_state: ReviewSurfaceLifecycleState,
    review_state: ReviewSurfaceReviewState,
    /** Meaningful only when parent_kind=slice. */
    build_state: ReviewSurfaceBuildState,
    latest_verification_run_id: UlidString.nullable().default(null),
    last_synced_external_revision: z
      .string()
      .min(1)
      .nullable()
      .default(null),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict()
  .refine(
    (s) => (s.parent_kind === "milestone" ? s.parent_phase != null : true),
    {
      message: "parent_phase required when parent_kind=milestone",
      path: ["parent_phase"],
    },
  )
  .refine(
    (s) => (s.parent_kind !== "milestone" ? s.parent_phase == null : true),
    {
      message:
        "parent_phase must be null when parent_kind != milestone",
      path: ["parent_phase"],
    },
  );

export type ReviewSurface = z.infer<typeof ReviewSurface>;
