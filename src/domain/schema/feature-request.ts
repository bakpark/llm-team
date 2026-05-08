import { z } from "zod";
import { UlidString } from "../ids.js";

/**
 * Feature Request intake record (FS-only Phase 5a).
 *
 * 사람이 `workdir/feature-requests/<request_id>.json` 에 drop 한 raw 요구.
 * `feature_request_promote` use case 가 이를 읽어 Milestone(M_INTAKE_QUEUED)
 * 으로 1회 전환한 뒤 `processed_at` 을 채워 영속화한다.
 *
 * Phase 5a 는 GitHub adapter 미도입 — `external_refs` 는 phase 6b 에서 채움.
 * `intake_state` 는 본 record 가 idempotent 하게 처리되도록 한다.
 */

export const FeatureRequestState = z.enum([
  "queued",
  "promoted",
  "rejected",
]);
export type FeatureRequestState = z.infer<typeof FeatureRequestState>;

export const FeatureRequest = z
  .object({
    request_id: UlidString,
    title: z.string().min(1),
    body: z.string().default(""),
    submitted_by: z.string().min(1),
    submitted_at: z.string().datetime(),
    state: FeatureRequestState,
    promoted_milestone_id: UlidString.nullable().default(null),
    processed_at: z.string().datetime().nullable().default(null),
    rejection_reason: z.string().min(1).nullable().default(null),
  })
  .strict();
export type FeatureRequest = z.infer<typeof FeatureRequest>;
