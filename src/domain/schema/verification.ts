import { z } from "zod";
import { UlidString } from "../ids.js";

/**
 * RGC-VERIFICATION schemas.
 *
 * VerificationRun is the deterministic-evidence record (build/test/lint/type
 * check / interface diff). MetricRun is the metric-threshold record
 * (refactor metrics). Both are evidence inputs to SOC-SESSION-TERMINATION's
 * `required_evidence` evaluation.
 */

export const VerificationResult = z.enum(["pass", "fail", "error"]);
export type VerificationResult = z.infer<typeof VerificationResult>;

export const FailedTest = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1),
    message: z.string().min(1).nullable().default(null),
  })
  .strict();
export type FailedTest = z.infer<typeof FailedTest>;

export const VerificationRun = z
  .object({
    verification_run_id: UlidString,
    target_id: z.string().min(1),
    target_revision: z.string().min(1),
    commands_or_checks: z.array(z.string().min(1)).default(() => []),
    environment_fingerprint: z.string().min(1),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    result: VerificationResult,
    failed_tests: z.array(FailedTest).default(() => []),
    log_ref: z.string().min(1).nullable().default(null),
    /**
     * KAC-TRACEABILITY (phase 8c, plan §G2-2): the AC-IDs this run is
     * intended to cover. Populated by the inner verification-runner from
     * `slice.ac_ids` for slice-scoped runs; aggregate scout runs leave it
     * empty (the per-slice rows carry the mapping).
     *
     * Optional / default `[]` so any historical VerificationRun JSON written
     * before phase 8c parses unchanged.
     */
    covers_ac_ids: z.array(z.string().min(1)).default(() => []),
  })
  .strict();
export type VerificationRun = z.infer<typeof VerificationRun>;

export const MetricResult = z.enum(["met", "unmet"]);
export type MetricResult = z.infer<typeof MetricResult>;

export const MetricComparator = z.enum(["lte", "lt", "gte", "gt", "eq"]);
export type MetricComparator = z.infer<typeof MetricComparator>;

export const MetricRun = z
  .object({
    metric_run_id: UlidString,
    target_id: z.string().min(1),
    metric_name: z.string().min(1),
    target_revision: z.string().min(1),
    value: z.number(),
    comparator: MetricComparator,
    threshold: z.number(),
    result: MetricResult,
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
  })
  .strict();
export type MetricRun = z.infer<typeof MetricRun>;
