import { z } from "zod";
import { UlidString } from "../ids.js";
import { ExternalRef } from "./external-ref.js";

export const SliceState = z.enum([
  "SLICE_PENDING",
  "SLICE_READY",
  "SLICE_BUILDING",
  "SLICE_REVIEWING",
  "SLICE_INTEGRATING",
  "SLICE_VALIDATED",
  "SLICE_BLOCKED",
]);
export type SliceState = z.infer<typeof SliceState>;

export const SliceKind = z.enum(["feature", "internal"]);
export type SliceKind = z.infer<typeof SliceKind>;

export const SliceDependencyEdge = z.enum(["blocks", "coordinates_with"]);
export type SliceDependencyEdge = z.infer<typeof SliceDependencyEdge>;

export const SliceDependency = z
  .object({
    slice_id: UlidString,
    edge_type: SliceDependencyEdge,
  })
  .strict();
export type SliceDependency = z.infer<typeof SliceDependency>;

export const AcceptanceTest = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1),
    ac_id: z.string().min(1),
  })
  .strict();
export type AcceptanceTest = z.infer<typeof AcceptanceTest>;

export const Slice = z
  .object({
    slice_id: UlidString,
    milestone_id: UlidString,
    slice_kind: SliceKind,
    value_statement: z.string().min(1),
    ac_ids: z.array(z.string().min(1)).default(() => []),
    acceptance_tests: z.array(AcceptanceTest).default(() => []),
    declared_scope: z.array(z.string().min(1)).default(() => []),
    declared_metric_threshold: z
      .object({
        metric_name: z.string().min(1),
        comparator: z.enum(["lte", "lt", "gte", "gt", "eq"]),
        value: z.number(),
      })
      .strict()
      .nullable()
      .default(null),
    interface_break: z.boolean().default(false),
    dependencies: z.array(SliceDependency).default(() => []),
    trunk_base_revision: z.string().min(1),
    dod_revision_pin: z.string().min(1),
    state: SliceState,
    current_session_id: UlidString.nullable().default(null),
    spawning_proposal_id: UlidString.nullable().default(null),
    abandoned_reason: z.string().min(1).nullable().default(null),
    external_refs: z.array(ExternalRef).default(() => []),
    /**
     * Phase 1 (cli-spicy-anchor.md §5): optional pointer to the active
     * ReviewSurface backing this slice's PR. Caller paths only — agent
     * envelopes never set this field. Phase 2/3 wires the writers; until
     * then, callers leave it absent.
     */
    review_surface_id: UlidString.optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type Slice = z.infer<typeof Slice>;
