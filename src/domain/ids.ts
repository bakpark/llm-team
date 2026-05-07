import { monotonicFactory, ulid } from "ulid";
import { z } from "zod";

// NOTE: monotonicFactory() is module-scoped. Worker Threads each load this
// module fresh, so monotonicity is per-thread, which matches our per-process
// id-generation usage.
const monotonic = monotonicFactory();

export type ULID = string;

export function newId(now?: number): ULID {
  return now == null ? ulid() : ulid(now);
}

export function newMonotonicId(now?: number): ULID {
  return now == null ? monotonic() : monotonic(now);
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Zod refinement for ULID-formatted identifiers. Use for any field that is
 * a *Caller-issued* id (Milestone, Slice, SliceMerge, DialogueSession,
 * SessionTurn, Manifest, VerificationRun, MetricRun, Decision, Proposal,
 * Lease). External-system identifiers (e.g. GitHub issue numbers) are not
 * ULID and must use a separate refinement.
 */
export const UlidString = z
  .string()
  .refine((s) => ULID_PATTERN.test(s), {
    message: "expected a 26-char Crockford base32 ULID",
  });
