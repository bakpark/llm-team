import { z } from "zod";
import { ExternalRef } from "./external-ref.js";

export const SliceMergeState = z.enum([
  "SM_DRAFT",
  "SM_READY_FOR_REVIEW",
  "SM_APPROVED",
  "SM_MERGED",
  "SM_REQUEST_CHANGES",
  "SM_CLOSED",
  "SM_STALE",
]);
export type SliceMergeState = z.infer<typeof SliceMergeState>;

export const SliceMerge = z
  .object({
    slice_merge_id: z.string().min(1),
    slice_id: z.string().min(1),
    target_id: z.string().min(1),
    pre_merge_workspace_revision: z.string().min(1).nullable(),
    merge_revision: z.string().min(1).nullable(),
    inner_session_id: z.string().min(1).nullable(),
    review_session_id: z.string().min(1).nullable(),
    verification_run_id: z.string().min(1).nullable(),
    state: SliceMergeState,
    merged_at: z.string().min(1).nullable(),
    merged_by_caller_id: z.string().min(1).nullable(),
    lease_token: z.string().min(1).nullable(),
    audit_chain_predecessor_id: z.string().min(1).nullable().default(null),
    external_refs: z.array(ExternalRef).default([]),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export type SliceMerge = z.infer<typeof SliceMerge>;
