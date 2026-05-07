/**
 * Persistence layout helpers — single authority for relative path mapping
 * inside `workdir/`. Mirrors `docs/architecture/persistence-layout.md` §1
 * with the Phase 1a additions: milestones/, slices/, slice_merges/.
 */

export const LEDGER_TRANSITIONS_PATH = "ledger/transitions.ndjson";
export const LOG_DAEMON_PATH = "log/daemon.ndjson";

export const layout = {
  milestone(milestoneId: string): string {
    return `milestones/${milestoneId}.json`;
  },
  slice(sliceId: string): string {
    return `slices/${sliceId}.json`;
  },
  sliceMerge(sliceMergeId: string): string {
    return `slice_merges/${sliceMergeId}.json`;
  },
  manifest(manifestId: string): string {
    return `manifests/${manifestId}.json`;
  },
  sessionMetadata(sessionId: string): string {
    return `sessions/${sessionId}/metadata.json`;
  },
  sessionTurn(sessionId: string, turnIndex: number): string {
    return `sessions/${sessionId}/turns/${turnIndex}.json`;
  },
  sessionFinalization(sessionId: string): string {
    return `sessions/${sessionId}/finalization.json`;
  },
  sessionSnapshot(sessionId: string, snapshotId: string): string {
    return `sessions/${sessionId}/snapshots/${snapshotId}.json`;
  },
  verification(verificationRunId: string): string {
    return `verifications/${verificationRunId}.json`;
  },
  metric(metricRunId: string): string {
    return `metrics/${metricRunId}.json`;
  },
  decision(decisionId: string): string {
    return `knowledge/decisions/${decisionId}.json`;
  },
  contextSummary(milestoneId: string): string {
    return `knowledge/context_summaries/${milestoneId}.json`;
  },
  refactorProposal(proposalId: string): string {
    return `knowledge/refactor_proposals/${proposalId}.json`;
  },
  workspaceRoot(sliceId: string): string {
    return `workspaces/${sliceId}`;
  },
  lease(leaseId: string): string {
    return `leases/${leaseId}.json`;
  },
  archiveOf(rel: string): string {
    if (rel.startsWith("archive/")) return rel;
    return `archive/${rel}`;
  },
} as const;
