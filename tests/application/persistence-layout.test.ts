import { describe, expect, it } from "vitest";
import { layout, LEDGER_TRANSITIONS_PATH } from "../../src/application/persistence-layout.js";

describe("persistence-layout", () => {
  it("ledger transitions path is the canonical NDJSON file", () => {
    expect(LEDGER_TRANSITIONS_PATH).toBe("ledger/transitions.ndjson");
  });

  it("phase 1a authoritative paths (Milestone, Slice, SliceMerge)", () => {
    expect(layout.milestone("M1")).toBe("milestones/M1.json");
    expect(layout.slice("S1")).toBe("slices/S1.json");
    expect(layout.sliceMerge("SM1")).toBe("slice_merges/SM1.json");
  });

  it("session and turn paths", () => {
    expect(layout.sessionMetadata("S1")).toBe("sessions/S1/metadata.json");
    expect(layout.sessionTurn("S1", 0)).toBe("sessions/S1/turns/0.json");
    expect(layout.sessionFinalization("S1")).toBe(
      "sessions/S1/finalization.json",
    );
    expect(layout.sessionSnapshot("S1", "SNAP1")).toBe(
      "sessions/S1/snapshots/SNAP1.json",
    );
  });

  it("verification, metric, knowledge, workspace, lease", () => {
    expect(layout.verification("V1")).toBe("verifications/V1.json");
    expect(layout.metric("MR1")).toBe("metrics/MR1.json");
    expect(layout.decision("D1")).toBe("knowledge/decisions/D1.json");
    expect(layout.contextSummary("M1")).toBe(
      "knowledge/context_summaries/M1.json",
    );
    expect(layout.refactorProposal("P1")).toBe(
      "knowledge/refactor_proposals/P1.json",
    );
    expect(layout.workspaceRoot("S1")).toBe("workspaces/S1");
    expect(layout.lease("L1")).toBe("leases/L1.json");
  });

  it("archiveOf prefixes archive/ idempotently", () => {
    expect(layout.archiveOf("milestones/M1.json")).toBe(
      "archive/milestones/M1.json",
    );
    expect(layout.archiveOf("archive/x")).toBe("archive/x");
  });
});
