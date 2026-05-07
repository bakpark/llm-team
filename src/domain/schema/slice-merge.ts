import { z } from "zod";
import { UlidString } from "../ids.js";
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
    slice_merge_id: UlidString,
    slice_id: UlidString,
    target_id: z.string().min(1),
    pre_merge_workspace_revision: z.string().min(1).nullable(),
    merge_revision: z.string().min(1).nullable(),
    inner_session_id: UlidString.nullable(),
    review_session_id: UlidString.nullable(),
    verification_run_id: UlidString.nullable(),
    state: SliceMergeState,
    merged_at: z.string().datetime().nullable(),
    merged_by_caller_id: z.string().min(1).nullable(),
    lease_token: z.string().min(1).nullable(),
    audit_chain_predecessor_id: UlidString.nullable().default(null),
    external_refs: z.array(ExternalRef).default(() => []),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type SliceMerge = z.infer<typeof SliceMerge>;
