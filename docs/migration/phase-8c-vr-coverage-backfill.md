# Phase 8c — VerificationRun `covers_ac_ids` backfill

Phase 8c (KAC-TRACEABILITY, plan §G2-2) introduces AC-level traceability:
each `Slice.ac_ids` entry must be evidenced by a `VerificationRun` whose
`covers_ac_ids` contains the AC. A passing VR that does not list the AC
converges Validation to FAIL via `aggregateAcTraceability` (status=`FAIL`).

## Rollout impact

- Pre-8c VRs persist with `covers_ac_ids: []` (zod default). Any slice
  with declared `ac_ids` that points at one of these VRs renders every
  declared AC as a FAIL row → next Validation aggregation derives FAIL.
- This is the **intended** migration signal: pre-8c evidence cannot prove
  AC coverage and must be re-emitted before a milestone can promote to
  M_DONE.
- However, deploying phase 8c into a target with live pre-8c VRs flips
  Validation immediately. Operators need a rollout plan rather than a
  surprise FAIL on the next M_DELIVERY_VALIDATING run.

## Recommended deploy procedure

1. **Pre-deploy audit.** Before merging the phase-8c branch, scan
   `verifications/*.json` per active target and list any VR whose
   `covers_ac_ids` is empty AND whose linked SliceMerge -> Slice has a
   non-empty `ac_ids`. Each such row will FAIL on first aggregation.
2. **Re-emit per slice.** For each impacted slice, run the inner
   verification cycle (`turn-worker.ts`) to produce a fresh VR with
   `covers_ac_ids` populated from `Slice.ac_ids` (the dispatch path now
   forwards them via `IntegrateInput.coversAcIds`). The new SliceMerge
   pointer makes the next aggregation pick up the fresh VR.
3. **Confirm aggregation.** Trigger a Validation cycle on a representative
   milestone and confirm `scout/ac_traceability/<milestone>.json` shows
   no FAIL rows whose root cause is empty `covers_ac_ids`.
4. **Operator escalation.** If a slice cannot be re-verified (e.g. its
   workspace was archived), park the milestone via
   `park_milestone_awaiting_human` rather than back-filling fake
   `covers_ac_ids` directly into the VR JSON — the audit chain expects VR
   bodies to be runner-authored.

## Why no automatic backfill

Mutating persisted `VerificationRun` bodies post-hoc would break the
audit chain: each VR's `audit_hash` is part of the manifest revision
pin used by KAC-MANIFEST. A dedicated re-run gives a fresh VR id and
preserves traceability.

## Code references

- Aggregator: `src/application/scout-observer.ts`
  (`aggregateAcTraceability`, `computeDerivedVerdict`).
- Persisted manifest: `scout/ac_traceability/<milestone_id>.json` (see
  `layout.acTraceabilityByMilestone`).
- Dispatch FAIL routing: `src/application/outer-turn.ts`
  (`buildDispatchInput` — phase 8c derives `responsibleSliceIds` from the
  manifest's FAIL/MISSING rows when the lead is PASS but scout downgrades
  to FAIL).
