/**
 * Phase prod-4 — LLM_TEAM_E2E live inner tdd_build scenario.
 *
 * DEFAULT-SKIP. The describe block is gated with vitest 2.x's
 * `describe.skipIf` so the entire suite is recorded as skipped unless
 * `LLM_TEAM_E2E=1` is exported. Live execution is deferred to human
 * operators (planning §7 — "deferred-to-human").
 *
 * The body is intentionally minimal: it asserts that the harness wiring
 * survives `LLM_TEAM_E2E=1` and that a placeholder live assertion would
 * run. The real live adapter wire-up is left to the human run path.
 */
import { describe, expect, it } from "vitest";

import { createE2eRun, snapshotBlastRadius, verifyBlastRadius } from "../helpers/e2e-harness.js";

const LIVE = process.env.LLM_TEAM_E2E === "1";

describe.skipIf(!LIVE)(
  "Phase prod-4 — inner tdd_build live (LLM_TEAM_E2E=1)",
  () => {
    it("creates a sandbox run handle and snapshots blast radius", () => {
      const handle = createE2eRun();
      try {
        expect(handle.target.identity.target_id).toBe("e2e-sandbox");
        expect(handle.costCapUsd).toBeGreaterThan(0);
        const baseline = snapshotBlastRadius();
        // Live forge round-trip would happen here. Until the human-only
        // run path lands, we assert the trivial invariant.
        verifyBlastRadius(baseline);
      } finally {
        handle.cleanup();
      }
    });
  },
);
