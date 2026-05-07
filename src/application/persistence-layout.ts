/**
 * Persistence layout helpers — single authority for relative path mapping
 * inside `workdir/`. Mirrors `docs/architecture/persistence-layout.md` §1
 * with the Phase 1a additions: milestones/, slices/, slice_merges/.
 *
 * All Caller-issued identifiers must be ULIDs; helpers reject any other shape
 * to prevent path traversal or layout corruption (e.g. `a/b` → directory
 * escape). External-system ids (GitHub issue numbers etc.) never appear here
 * — they live only inside `external_refs[]` payloads.
 */

import { isUlid } from "../domain/ids.js";

export const LEDGER_TRANSITIONS_PATH = "ledger/transitions.ndjson";
export const LOG_DAEMON_PATH = "log/daemon.ndjson";

function requireUlid(name: string, value: string): string {
  if (!isUlid(value))
    throw new Error(`${name} must be a 26-char Crockford base32 ULID`);
  return value;
}

function requireTurnIndex(value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error("turn_index must be a non-negative integer");
  return value;
}

export const layout = {
  milestone(milestoneId: string): string {
    return `milestones/${requireUlid("milestone_id", milestoneId)}.json`;
  },
  slice(sliceId: string): string {
    return `slices/${requireUlid("slice_id", sliceId)}.json`;
  },
  sliceMerge(sliceMergeId: string): string {
    return `slice_merges/${requireUlid("slice_merge_id", sliceMergeId)}.json`;
  },
  manifest(manifestId: string): string {
    return `manifests/${requireUlid("manifest_id", manifestId)}.json`;
  },
  sessionMetadata(sessionId: string): string {
    return `sessions/${requireUlid("session_id", sessionId)}/metadata.json`;
  },
  sessionTurn(sessionId: string, turnIndex: number): string {
    return `sessions/${requireUlid("session_id", sessionId)}/turns/${requireTurnIndex(turnIndex)}.json`;
  },
  sessionFinalization(sessionId: string): string {
    return `sessions/${requireUlid("session_id", sessionId)}/finalization.json`;
  },
  sessionSnapshot(sessionId: string, snapshotId: string): string {
    return `sessions/${requireUlid("session_id", sessionId)}/snapshots/${requireUlid("snapshot_id", snapshotId)}.json`;
  },
  verification(verificationRunId: string): string {
    return `verifications/${requireUlid("verification_run_id", verificationRunId)}.json`;
  },
  metric(metricRunId: string): string {
    return `metrics/${requireUlid("metric_run_id", metricRunId)}.json`;
  },
  decision(decisionId: string): string {
    return `knowledge/decisions/${requireUlid("decision_id", decisionId)}.json`;
  },
  contextSummary(milestoneId: string): string {
    return `knowledge/context_summaries/${requireUlid("milestone_id", milestoneId)}.json`;
  },
  refactorProposal(proposalId: string): string {
    return `knowledge/refactor_proposals/${requireUlid("proposal_id", proposalId)}.json`;
  },
  workspaceRoot(sliceId: string): string {
    return `workspaces/${requireUlid("slice_id", sliceId)}`;
  },
  lease(leaseId: string): string {
    return `leases/${requireUlid("lease_id", leaseId)}.json`;
  },
  archiveOf(rel: string): string {
    if (rel.startsWith("archive/")) return rel;
    return `archive/${rel}`;
  },
} as const;
