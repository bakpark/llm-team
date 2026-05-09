/**
 * Phase prod-5 — LLM_TEAM_E2E live failure-paths scenario.
 *
 * DEFAULT-SKIP. Live execution is deferred to human (planning §8 —
 * "deferred-to-human"). The `*-mock.test.ts` companion exercises the
 * timeout / transport_error / malformed_output branches through the
 * runtime port without an actual LLM call.
 */
import { describe, expect, it } from "vitest";

import { createE2eRun, snapshotBlastRadius, verifyBlastRadius } from "../helpers/e2e-harness.js";

const LIVE = process.env.LLM_TEAM_E2E === "1";

describe.skipIf(!LIVE)(
  "Phase prod-5 — failure-paths live (LLM_TEAM_E2E=1)",
  () => {
    it("creates a sandbox run handle and snapshots blast radius", () => {
      const handle = createE2eRun();
      try {
        expect(handle.target.identity.target_id).toBe("e2e-sandbox");
        expect(handle.costCapUsd).toBeGreaterThan(0);
        const baseline = snapshotBlastRadius();
        verifyBlastRadius(baseline);
      } finally {
        handle.cleanup();
      }
    });
  },
);
