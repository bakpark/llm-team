import { describe, expect, it } from "vitest";
import {
  layout,
  LEDGER_TRANSITIONS_PATH,
} from "../../src/application/persistence-layout.js";

const M_ID = "01HZM00000000000000000000A";
const S_ID = "01HZS00000000000000000000A";
const SM_ID = "01HZSM0000000000000000000A";
const MAN_ID = "01HZMN0000000000000000000A";
const SESS_ID = "01HZSE0000000000000000000A";
const SNAP_ID = "01HZSN0000000000000000000A";
const VERIF_ID = "01HZVR0000000000000000000A";
const METRIC_ID = "01HZMR0000000000000000000A";
const DECISION_ID = "01HZDC0000000000000000000A";
const PROPOSAL_ID = "01HZPP0000000000000000000A";
const LEASE_ID = "01HZQQ0000000000000000000A";

describe("persistence-layout", () => {
  it("ledger transitions path is the canonical NDJSON file", () => {
    expect(LEDGER_TRANSITIONS_PATH).toBe("ledger/transitions.ndjson");
  });

  it("phase 1a authoritative paths (Milestone, Slice, SliceMerge)", () => {
    expect(layout.milestone(M_ID)).toBe(`milestones/${M_ID}.json`);
    expect(layout.slice(S_ID)).toBe(`slices/${S_ID}.json`);
    expect(layout.sliceMerge(SM_ID)).toBe(`slice_merges/${SM_ID}.json`);
  });

  it("session and turn paths", () => {
    expect(layout.sessionMetadata(SESS_ID)).toBe(
      `sessions/${SESS_ID}/metadata.json`,
    );
    expect(layout.sessionTurn(SESS_ID, 0)).toBe(
      `sessions/${SESS_ID}/turns/0.json`,
    );
    expect(layout.sessionFinalization(SESS_ID)).toBe(
      `sessions/${SESS_ID}/finalization.json`,
    );
    expect(layout.sessionSnapshot(SESS_ID, SNAP_ID)).toBe(
      `sessions/${SESS_ID}/snapshots/${SNAP_ID}.json`,
    );
  });

  it("verification, metric, knowledge, workspace, lease", () => {
    expect(layout.verification(VERIF_ID)).toBe(
      `verifications/${VERIF_ID}.json`,
    );
    expect(layout.metric(METRIC_ID)).toBe(`metrics/${METRIC_ID}.json`);
    expect(layout.decision(DECISION_ID)).toBe(
      `knowledge/decisions/${DECISION_ID}.json`,
    );
    expect(layout.contextSummary(M_ID)).toBe(
      `knowledge/context_summaries/${M_ID}.json`,
    );
    expect(layout.refactorProposal(PROPOSAL_ID)).toBe(
      `knowledge/refactor_proposals/${PROPOSAL_ID}.json`,
    );
    expect(layout.workspaceRoot(S_ID)).toBe(`workspaces/${S_ID}`);
    expect(layout.lease(LEASE_ID)).toBe(`leases/${LEASE_ID}.json`);
  });

  it("rejects non-ULID ids (path traversal defense)", () => {
    expect(() => layout.milestone("not-a-ulid")).toThrow(/ULID/);
    expect(() => layout.milestone("../escape/M1")).toThrow(/ULID/);
    expect(() => layout.slice("a/b")).toThrow(/ULID/);
    expect(() => layout.sliceMerge("")).toThrow(/ULID/);
  });

  it("rejects negative or non-integer turn_index", () => {
    expect(() => layout.sessionTurn(SESS_ID, -1)).toThrow(/non-negative/);
    expect(() => layout.sessionTurn(SESS_ID, 1.5)).toThrow(/non-negative/);
  });

  it("archiveOf prefixes archive/ idempotently", () => {
    expect(layout.archiveOf(`milestones/${M_ID}.json`)).toBe(
      `archive/milestones/${M_ID}.json`,
    );
    expect(layout.archiveOf("archive/x")).toBe("archive/x");
  });

  it("phase 5a paths (slice telemetry, feature request, signals, releases)", () => {
    const TELEM_ID = "01HZTM0000000000000000000A";
    const REQ_ID = "01HZFR0000000000000000000A";
    expect(layout.sliceTelemetry(TELEM_ID)).toBe(
      `knowledge/slice_telemetry/${TELEM_ID}.json`,
    );
    expect(layout.latestSliceTelemetryByMilestone(M_ID)).toBe(
      `knowledge/slice_telemetry/by_milestone/${M_ID}.json`,
    );
    expect(() => layout.latestSliceTelemetryByMilestone("bad")).toThrow(/ULID/);
    expect(layout.featureRequest(REQ_ID)).toBe(
      `feature_requests/${REQ_ID}.json`,
    );
    expect(layout.humanSignal("IC_kgD0xyz123")).toBe(
      `human_signals/IC_kgD0xyz123.json`,
    );
    expect(layout.humanSignal(REQ_ID)).toBe(`human_signals/${REQ_ID}.json`);
    expect(layout.humanSignalProcessed("IC_kgD0xyz123")).toBe(
      `human_signals/processed/IC_kgD0xyz123.json`,
    );
    expect(layout.release(M_ID)).toBe(`releases/${M_ID}.json`);
  });

  it("rejects path traversal in human-signal id", () => {
    expect(() => layout.humanSignal("../escape")).toThrow();
    expect(() => layout.humanSignal("a/b")).toThrow();
    expect(() => layout.humanSignal("")).toThrow();
  });
});
