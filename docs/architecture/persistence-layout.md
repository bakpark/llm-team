# Persistence Layout

본 문서는 contract 가 정의한 영속 객체들의 *저장 위치, ID 발급, 원자적 write, retention* 을 다룬다. 콘텐츠 의미는 contract 가 단일 권위다 — 본 문서는 architecture 한정 매핑이다.

contract cross-link:
- [`KAC-MANIFEST`](../contracts/knowledge-contract.md#KAC-MANIFEST), [`KAC-SESSION-LOG-STORAGE`](../contracts/knowledge-contract.md#KAC-SESSION-LOG-STORAGE), [`KAC-TURN-LOG-COMPACTION`](../contracts/knowledge-contract.md#KAC-TURN-LOG-COMPACTION)
- [`RGC-VERIFICATION`](../contracts/reliability-and-gate-contract.md#RGC-VERIFICATION), [`RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER)

## 1. 디렉토리 트리

target 워크디렉토리(`workdir/`) 하위에 다음 layout 으로 영속화한다.

```text
workdir/
  ledger/
    transitions.ndjson              # RGC-LEDGER append-only
  manifests/
    <manifest_id>.json              # AGC-CONTEXT-MANIFEST 본체
  sessions/
    <session_id>/
      metadata.json                 # DialogueSession metadata (참조용)
      turns/
        <turn_index>.json           # SessionTurn envelope + caller_routing_decision + workspace_commit + verification_result_ref
      snapshots/
        <snapshot_id>.json          # KAC-TURN-LOG-COMPACTION 압축 결과
      finalization.json             # 종료 시 final_verdict + finalization_decision
  verifications/
    <verification_run_id>.json      # RGC-VERIFICATION VerificationRun
    logs/
      <verification_run_id>/        # 로그 본문 (log_ref 가 가리킴)
  metrics/
    <metric_run_id>.json            # RGC-VERIFICATION MetricRun
  knowledge/
    decisions/
      <decision_id>.json            # KAC-DECISION-LOG
    context_summaries/
      <milestone_id>.json           # KAC-CONTEXT-SUMMARY
    refactor_proposals/
      <proposal_id>.json            # KAC-REFACTOR-BACKLOG
  workspaces/
    <slice_id>/                     # inner tdd_build worktree (격리). turn worker 가 관리
```

`workdir/` 의 절대 경로는 target 별로 [`TCC-IDENTITY`](../contracts/target-config-contract.md#TCC-IDENTITY) 가 결정한다.

## 2. ID 발급

| 객체 | 발급 주체 | 알고리즘 |
|---|---|---|
| `manifest_id` | Caller (`context_manifest_create` operation) | ULID. 단조 증가 시간 prefix + entropy |
| `session_id` | Caller (DialogueSession 생성 시점) | ULID |
| `turn_index` | Caller (turn worker 의 CAS) | session-local `current_turn_index` 의 atomic increment |
| `snapshot_id` (turn_log compaction) | Caller (dialogue coordinator) | ULID |
| `verification_run_id` | Caller (verification_runner) | ULID |
| `metric_run_id` | Caller | ULID |
| `decision_id` | Caller (knowledge writer) | ULID |
| `proposal_id` | Caller (RefactorBacklog writer) | ULID |
| `workspace_commit` (SHA) | turn worker post-validate (git commit) | git commit SHA1/SHA256 (저장소 설정) |
| `slice_merge_id` | Caller (SliceMerge create operation) | ULID |
| `external_refs[].id` | 외부 시스템 | 외부 시스템 어댑터의 발급값 (예: GitHub Issue 번호) — 내부에서 발급하지 않음 |

ULID 채택 이유:
- 시간 prefix 가 monotonically 정렬 가능 → ledger 의 시간 순서 audit 와 정합.
- entropy 하위 80 bit → 분산 발급 안전.
- 26자 base32 표현 → URL/파일명 안전.

ID 의 *결정성* 은 보장하지 않는다 (replay 시 동일 ID 재현 X). 결정성이 필요한 idempotency_key 는 [`SOC-IDEMPOTENCY`](../contracts/state-and-operation-contract.md#SOC-IDEMPOTENCY) 의 3-scope 합성식이 별도로 정의한다.

## 3. 원자적 Write

모든 객체 write 는 *rename-after-write* 패턴으로 원자성을 확보한다.

```text
# pseudo
tmp = ${target}.tmp.<pid>.<random>
write_full(tmp, body)
fsync(tmp)
rename(tmp, target)               # POSIX rename atomicity
fsync(parent_dir)
```

ledger 의 `transitions.ndjson` 은 append-only 이므로 `O_APPEND` flag 와 `flock(LOCK_EX)` 의 짧은 critical section 으로 직렬화한다. fsync 정책은 `target.persistence.fsync_mode` (TCC) 가 결정 (default = 매 row 마다 fsync).

ledger row 의 무결성은 `audit_hash` (RGC-LEDGER 가 정의) 가 보호한다. partial write 가 감지되면 `application/recovery.sh` 의 ledger replay 가 incomplete row 를 drop 하고 lease 회수 절차를 시작한다.

## 4. Retention / GC

| 영역 | 정책 |
|---|---|
| `manifests/` | M_DONE / M_ESCALATED 도달 후 N 일 (TCC `target.persistence.retention.manifest_days`, default 90) |
| `sessions/` | M_DONE / M_ESCALATED 도달 후 archive 영역으로 이동. session_log_ref 는 invalidation 되지 않음 (audit_chain 보존) |
| `verifications/`, `metrics/` | retention 정책은 manifest 와 동일 |
| `knowledge/` | 영구 보존 — 누적 스펙은 후속 milestone 의 1급 입력 (`KAC-ACCUMULATION`) |
| `workspaces/` | inner session 종료 시 즉시 정리. 단 `SM_DRAFT` / `SM_READY_FOR_REVIEW` 동안은 보존. SliceMerge terminal 이후 GC |
| `ledger/transitions.ndjson` | 영구 append. compaction 은 본 layout 이 정의하지 않음 (별도 archive 정책) |

archive 영역의 path 는 `workdir/archive/` 하위에 동일 layout 을 미러한다. archive 이동은 단순 rename 이며, 외부에서 보는 path 식별자는 `archive/` prefix 가 붙는다 — 따라서 cross-reference 가 깨지지 않는다.

## 5. Replay / Recovery

`application/recovery.sh` 는 시작 시 다음 순서로 stale 객체를 복구한다 ([`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)):

1. ledger replay → 미완료 transition 식별.
2. lease 만료 검사 (`RGC-LEASE-KINDS`).
3. 디렉토리 트리 스캔 → orphan tmp 파일 정리.
4. session 별 finalization.json 검증 → AWAITING_REVALIDATION / TIMEOUT 분류.
5. SliceMerge `SM_STALE` 검사 → trunk pin 비교.

본 문서는 *layout 의 일관성* 만 보장한다. 회복 알고리즘 자체는 [`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY) 와 `application/recovery.sh` 가 단일 권위.

## 6. 외부 시스템과의 관계

`external_refs[]` ([`SOC-OBJECTS`](../contracts/state-and-operation-contract.md#SOC-OBJECTS)) 의 외부 mirror 는 본 layout 의 일부가 아니다. 매핑은 [`external-tracking-mapping.md`](external-tracking-mapping.md) 가 정의한다.

본 layout 의 모든 ID 는 외부 시스템 ID 와 독립적이다. 외부 시스템 ID 는 객체의 `external_refs[].id` 필드로만 등장한다.

## 7. 변경 정책

본 layout 의 변경은 다음을 모두 만족해야 한다.

- 기존 `<id>.json` 파일의 위치를 옮기는 변경은 ledger replay 호환성 검사를 통과해야 함.
- 새 ID 알고리즘 도입은 기존 ID 의 인식 가능성을 깨지 않아야 함 (parser union read).
- retention/archive 정책 변경은 사람 governance signal 동의를 요구한다 (audit chain 의 가용성에 영향).
