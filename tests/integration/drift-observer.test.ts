/**
 * Phase 6b — drift_observer test (external-tracking-mapping.md §5/§6).
 *
 * - non-signal external mutation (label edit / close) on a Slice's mirrored
 *   issue → external_refs[].sync_status = conflict + ledger
 *   action_kind=external_observation row.
 * - external surface disappears (orphan) → same conflict transition with
 *   reason="disappeared".
 * - second sweep over an already-conflict ref is a noop (idempotent).
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { FixedClock } from "../../src/ports/clock.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  LEDGER_TRANSITIONS_PATH,
  layout,
} from "../../src/application/persistence-layout.js";
import { FsMirrorIssueTracker } from "../../src/adapters/issue-tracker/fs-mirror.js";
import { FsMirrorGitHost } from "../../src/adapters/git-host/fs-mirror.js";
import { runDriftObserverSweep } from "../../src/application/drift-observer.js";
import { Slice } from "../../src/domain/schema/slice.js";
import { SliceMerge } from "../../src/domain/schema/slice-merge.js";

const ISO_BASE = "2026-05-08T00:00:00.000Z";
const SLICE_ID = "01HZSA00000000000000000001";
const SLICE_MERGE_ID = "01HZSM00000000000000000001";
const MILESTONE_ID = "01HZMS00000000000000000001";

async function persistSlice(
  store: MemoryStore,
  trackerId: string,
  initialRevision: string,
): Promise<void> {
  const sl = Slice.parse({
    slice_id: SLICE_ID,
    milestone_id: MILESTONE_ID,
    slice_kind: "feature",
    value_statement: "x",
    ac_ids: [],
    acceptance_tests: [],
    declared_scope: [],
    declared_metric_threshold: null,
    interface_break: false,
    dependencies: [],
    trunk_base_revision: "deadbeef",
    dod_revision_pin: "deadbeef",
    state: "SLICE_BUILDING",
    current_session_id: null,
    spawning_proposal_id: null,
    abandoned_reason: null,
    external_refs: [
      {
        provider: "fs-mirror",
        kind: "tracker",
        id: trackerId,
        sync_status: "synced",
        last_seen_external_revision: initialRevision,
        last_synced_internal_revision: "rev1",
      },
    ],
    created_at: ISO_BASE,
    updated_at: ISO_BASE,
  });
  await store.writeAtomic(layout.slice(SLICE_ID), JSON.stringify(sl, null, 2));
}

async function persistSliceMerge(
  store: MemoryStore,
  prId: string,
  initialRevision: string,
): Promise<void> {
  const sm = SliceMerge.parse({
    slice_merge_id: SLICE_MERGE_ID,
    slice_id: SLICE_ID,
    target_id: "demo",
    pre_merge_workspace_revision: "head1",
    merge_revision: null,
    inner_session_id: null,
    review_session_id: null,
    verification_run_id: null,
    state: "SM_DRAFT",
    merged_at: null,
    merged_by_caller_id: null,
    lease_token: null,
    audit_chain_predecessor_id: null,
    external_refs: [
      {
        provider: "fs-mirror",
        kind: "review_surface",
        id: prId,
        sync_status: "synced",
        last_seen_external_revision: initialRevision,
      },
    ],
    created_at: ISO_BASE,
    updated_at: ISO_BASE,
  });
  await store.writeAtomic(
    layout.sliceMerge(SLICE_MERGE_ID),
    JSON.stringify(sm, null, 2),
  );
}

function makeDeps(store: MemoryStore) {
  const clock = new FixedClock(Date.parse(ISO_BASE));
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  const issueTracker = new FsMirrorIssueTracker(store);
  const gitHost = new FsMirrorGitHost(store);
  return { clock, logger, ledger, issueTracker, gitHost };
}

describe("drift-observer (Phase 6b)", () => {
  it("flips Slice external_refs to conflict on revision_mismatch", async () => {
    const store = new MemoryStore();
    const { clock, ledger, issueTracker, gitHost } = makeDeps(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: ["slice-state/building"],
    });
    // initial revision is "1" after createIssue.
    await persistSlice(store, issue.id, "1");

    // Out-of-band mutation: external user edits labels (revision becomes 2).
    await issueTracker.__externalMutate(issue, (s) => ({
      ...s,
      labels: [...s.labels, "manually-tagged"],
    }));

    const out = await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    expect(out.conflicts.length).toBe(1);
    expect(out.conflicts[0]!.reason).toBe("revision_mismatch");

    const persisted = Slice.parse(
      JSON.parse((await store.readText(layout.slice(SLICE_ID)))!),
    );
    expect(persisted.external_refs[0]!.sync_status).toBe("conflict");

    const ledgerLines =
      (await store.readText(LEDGER_TRANSITIONS_PATH))?.trim().split("\n") ?? [];
    const obs = ledgerLines.find((l) =>
      l.includes('"action_kind":"external_observation"'),
    );
    expect(obs, "expected external_observation row").toBeDefined();
  });

  it("orphan (external surface deleted) → conflict with reason=disappeared", async () => {
    const store = new MemoryStore();
    const { clock, ledger, issueTracker, gitHost } = makeDeps(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: [],
    });
    await persistSlice(store, issue.id, "1");
    await issueTracker.__externalDelete(issue);

    const out = await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    expect(out.conflicts.length).toBe(1);
    expect(out.conflicts[0]!.reason).toBe("disappeared");
    const persisted = Slice.parse(
      JSON.parse((await store.readText(layout.slice(SLICE_ID)))!),
    );
    expect(persisted.external_refs[0]!.sync_status).toBe("conflict");
  });

  it("no drift → no conflicts and no extra ledger rows", async () => {
    const store = new MemoryStore();
    const { clock, ledger, issueTracker, gitHost } = makeDeps(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: [],
    });
    await persistSlice(store, issue.id, "1");

    const before = await store.readText(LEDGER_TRANSITIONS_PATH);
    const out = await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    expect(out.conflicts.length).toBe(0);
    const after = await store.readText(LEDGER_TRANSITIONS_PATH);
    expect(after ?? "").toBe(before ?? "");
  });

  it("idempotent: second sweep over already-conflict ref is a noop", async () => {
    const store = new MemoryStore();
    const { clock, ledger, issueTracker, gitHost } = makeDeps(store);
    const issue = await issueTracker.createIssue({
      kind: "tracker",
      title: "S",
      body: "",
      labels: [],
    });
    await persistSlice(store, issue.id, "1");
    await issueTracker.__externalMutate(issue, (s) => ({
      ...s,
      labels: ["x"],
    }));
    await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    const ledgerSize1 = (
      await store.readText(LEDGER_TRANSITIONS_PATH)
    )?.length;
    const out2 = await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    expect(out2.conflicts.length).toBe(0);
    const ledgerSize2 = (
      await store.readText(LEDGER_TRANSITIONS_PATH)
    )?.length;
    expect(ledgerSize2).toBe(ledgerSize1);
  });

  it("SliceMerge PR drift flips review_surface to conflict", async () => {
    const store = new MemoryStore();
    const { clock, ledger, issueTracker, gitHost } = makeDeps(store);
    const pr = await gitHost.openPullRequest({
      title: "S",
      body: "",
      headBranch: "slice/1",
      baseBranch: "main",
      draft: true,
      labels: ["sm-state/draft"],
    });
    await persistSliceMerge(store, pr.id, "1");
    // External user toggles draft (post a label change via update path)
    await gitHost.updatePullRequest({
      prRef: pr,
      labels: ["sm-state/draft", "external-tag"],
    });
    const out = await runDriftObserverSweep({
      store,
      clock,
      ledger,
      issueTracker,
      gitHost,
      callerId: "drift",
      targetId: "demo",
    });
    expect(out.conflicts.length).toBe(1);
    expect(out.conflicts[0]!.object_kind).toBe("slice_merge");
  });
});
