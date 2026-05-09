/**
 * Phase prod-5 — LLM_TEAM_E2E live middle review approve scenario.
 *
 * DEFAULT-SKIP. Mirrors the phase-prod-4 inner-tdd-build live wrapper:
 * `describe.skipIf(!LIVE)` so the suite is recorded as skipped unless the
 * operator opts in with LLM_TEAM_E2E=1. Live execution (real sentinel
 * adapter wired into runOneMiddleReviewTurn) is deferred to human (planning
 * §8 — "deferred-to-human").
 *
 * The mock smoke covering SM_READY_FOR_REVIEW → SM_MERGED + SLICE_VALIDATED
 * lives next to this file as `middle-review-approve-mock.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { createE2eRun, snapshotBlastRadius, verifyBlastRadius } from "../helpers/e2e-harness.js";

const LIVE = process.env.LLM_TEAM_E2E === "1";

describe.skipIf(!LIVE)(
  "Phase prod-5 — middle review approve live (LLM_TEAM_E2E=1)",
  () => {
    it("creates a sandbox run handle and snapshots blast radius", () => {
      const handle = createE2eRun();
      try {
        expect(handle.target.identity.target_id).toBe("e2e-sandbox");
        expect(handle.costCapUsd).toBeGreaterThan(0);
        const baseline = snapshotBlastRadius();
        // Live sentinel review round-trip would happen here. Until the
        // human-only run path lands the harness only asserts the trivial
        // invariant.
        verifyBlastRadius(baseline);
      } finally {
        handle.cleanup();
      }
    });
  },
);
