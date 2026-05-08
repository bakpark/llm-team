import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // PR #64 review P0-2 fix added `withFileLock` around several slice
    // writes (caller-dispatch.transitionSliceState, turn-worker's
    // SLICE_REVIEWING write, pickReadyMiddleReview's current_session_id
    // update). Each integration test now performs more lockdir
    // mkdir/rmdir cycles; under parallel-worker filesystem contention the
    // 5s default trips occasionally. Bumped to 15s to cover the realistic
    // worst case while still surfacing genuine hangs.
    testTimeout: 15_000,
  },
});
