# Knowledge Contract

본 문서는 누적 스펙, manifest, decision log, context summary, AC traceability, RefactorBacklog, turn_log compaction, slice telemetry 의 영속화·inject path 를 정의한다.

<a id="KAC-SCOPE"></a>
## KAC-SCOPE: Scope

이 문서의 authoritative scope 는 다음이다.

- 누적 스펙의 수명주기
- Manifest 와 Decision Log
- Context Summary
- Acceptance Criteria traceability (AC → slice → SliceMerge → VerificationRun)
- 충돌 우선순위와 불변성
- RefactorBacklog / RefactorProposal 의 1급 객체 lifecycle
- DialogueSession 의 session_log storage 정책
- turn_log compaction 정책
- Slice telemetry inject path

Agent 호출의 Context Manifest 는 `docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST` 가 정의한다.

<a id="KAC-ACCUMULATION"></a>
## KAC-ACCUMULATION: Accumulated Specs

스펙은 누적 산출물이다. outer Discovery / Specification phase 의 final artifact, 중요한 결정, 거부된 대안, Context Summary 는 milestone 종료 후에도 보존된다.

누적 스펙은 다음 milestone 의 1급 입력이다. outer Discovery / Specification 의 lead contribution 은 새 작업이 기존 결정과 모순되지 않는지 확인할 책임을 갖는다.

병합된 스펙은 후속 milestone 이 명시적으로 갱신하지 않는 한 변경하지 않는다. 변경 시 사유를 Decision Log 에 기록한다.

거부되거나 회수된 Spec CP 는 병합된 스펙으로 누적하지 않는다. 다만 거부 사유, 회수 사유, 반복 금지해야 할 대안은 `#KAC-DECISION-LOG` 의 `alternatives` 와 `rationale` 로 누적한다. 다음 outer Discovery / Specification 호출의 manifest 는 현재 scope 와 관련된 최근 거부 사유를 decision entry 로 포함해야 하며, 이를 생략하면 후속 milestone 이 같은 거부 사유를 반복할 수 있으므로 invalid manifest 로 본다.

### Live Telemetry

dual-slot serialization (`#SOC-MILESTONE-DUAL-SLOT`) 에 의해 Discovery N+1 의 manifest 는 진행 중 Delivery N 의 *live telemetry* 도 포함한다 (`#KAC-SLICE-TELEMETRY`). 누적 스펙이 *완료* 결과만 포함하는 것과 다르며, Discovery 가 추정이 아닌 진행 현실에 기반하도록 한다.

<a id="KAC-MANIFEST"></a>
## KAC-MANIFEST: Spec Manifest

Manifest 는 누적 스펙의 인덱스다.

항목 필수 필드:

| 필드 | 의미 |
|---|---|
| `milestone_id` | 관련 milestone |
| `artifact_kind` | research, scenario, decision, context_summary, refactor_proposal, slice_telemetry, external_ref_pointer 등 |
| `artifact_id` | 스펙 산출물 식별자 |
| `revision_pin` | 현재 revision |
| `summary` | 1-2 문장 요약 |
| `updated_at` | 갱신 시각 |
| `audit_hash` | 누적 스펙 entry 의 변형 검출용 hash. 변형 시 manifest 가 stale 로 판정되어 entry 재발급 필요 |

`artifact_kind=external_ref_pointer` 는 SOC 객체 (Milestone / Slice / SliceMerge) 의 `external_refs[]` 슬롯 (`docs/contracts/state-and-operation-contract.md#SOC-OBJECTS`) 의 manifest 노출용 포인터다. 본 contract 는 외부 시스템 mirror 의 의미를 정의하지 않으며, SOC 의 추상 슬롯과 architecture 의 매핑 문서가 단일 권위다.

outer Discovery / Specification phase 호출에서 Manifest 는 우선순위가 가장 높은 읽기 대상이다.

<a id="KAC-MANIFEST-FROM-KNOWLEDGE"></a>
## KAC-MANIFEST-FROM-KNOWLEDGE: Manifest Materialization

다음 milestone 의 outer Discovery / Specification 호출에서 누적 스펙은 `AGC-CONTEXT-MANIFEST` 의 entry 로 변환되어 입력된다.

### 변환 규칙

Caller 는 `KAC-MANIFEST` 의 항목을 manifest entry 로 변환할 때 다음을 따른다.

- `artifact_kind` 는 manifest entry 의 `object_kind` 에 매핑한다. 변환 시 의미가 좁아지지 않도록 1:1 또는 그룹화로 매핑하며, 임의로 폐기하지 않는다.
- `artifact_id` 는 entry 의 `object_id` 로, `revision_pin` 은 entry 의 `revision_pin` 으로 그대로 보존한다.
- `summary` 는 entry 의 `purpose` 또는 부속 메타로 사용한다. 본문은 self-fetch 로 얻으며, 본 절이 본문을 manifest 에 직접 임베드하지 않는다.
- 동일 milestone 에서 결정 우선순위가 다른 항목이 충돌하면 `#KAC-CONFLICTS` 의 우선순위에 따라 *상위* 항목만 entry 로 포함한다.
- `audit_hash` 가 manifest 변환 시 재계산되며, entry 의 stale 검출 기준이 된다.

### 필수 entry

outer Discovery / Specification 호출의 manifest 는 최소 다음을 포함한다.

- 직전 milestone 의 Context Summary
- 진행 중 Delivery slot 의 slice telemetry (`#KAC-SLICE-TELEMETRY`) — Discovery N+1 한정
- 현재 사람 승인 시그널 (또는 `human_approval` contribution) 이 인용한 스펙 (있을 때)
- 최신 병합된 outer Discovery / Specification phase 의 final artifact
- 최근 Decision Log 중 현재 milestone scope 과 관련된 항목 — 거부되거나 회수된 Spec CP 의 사유 포함
- RefactorBacklog 의 architectural debt 지표 중 본 milestone 과 관련된 항목

이 entry 들은 `required: true` 로 표시한다. 누락은 invalid manifest 이며, Caller 는 호출 전에 생성을 보장해야 한다.

### Turn Manifest 의 추가 규칙

DialogueSession 안의 turn 호출에서 manifest 는 직전 turn_log_snapshot 을 entry 로 포함한다 — `#KAC-TURN-LOG-COMPACTION` 의 압축 결과를 사용. 그 외 외부 객체는 turn manifest 밖이면 fetch 금지 (`llm-team.md` Inv #9).

### 변환의 책임

manifest 생성은 Caller 단독 책임이다. Agent 는 manifest 외부 객체를 self-fetch 하지 않는다 (`AGC-CONTEXT-MANIFEST`). 따라서 누적 스펙이 다음 milestone 에 *전달되지 않으면* 그 결정은 시스템적으로 보이지 않게 되며, 이는 헌법 Inv #7 (Knowledge accumulation) 위반이다.

<a id="KAC-DECISION-LOG"></a>
## KAC-DECISION-LOG: Decision Log

Decision Log 는 중요한 트레이드오프와 거부된 대안을 기록한다.

### 항목 필수 필드

- `decision_id`
- `decision_kind` — enum: `product_decision` / `refactor` / `spike_finding` / `architectural_debt` / `cross_milestone_amendment` / `acceptance_test_amendment`
- `decision`
- `alternatives`
- `rationale`
- `decided_at` — ISO-8601(UTC). 호출자가 결정 시각을 사전 주입하지 않은 경우, ledger 기록 helper 는 append-time(저장 시각)으로 자동 채운다
- `affected_milestones`
- `affected_slices` — 관련 slice 식별자 (있을 때)
- `supersedes` — 대체된 결정의 decision_id (있을 때)
- `audit_hash`

### Decision Kind 의미

| Kind | 의미 | 주 producer |
|---|---|---|
| `product_decision` | feature scope, spec content, AC 결정 | atlas (outer Discovery / Specification) |
| `refactor` | RefactorProposal 의 결정 — `internal` slice 로 promotion 또는 SUPERSEDED | atlas (Planning curation) |
| `spike_finding` | technical spike 의 결과로 stand-down 된 가설 | scout / forge |
| `architectural_debt` | RefactorBacklog 에 신규 architectural debt 등록 결정 | sentinel / scout |
| `cross_milestone_amendment` | Discovery N+1 발견을 N scope 로 흡수 | atlas (outer) + human approval |
| `acceptance_test_amendment` | acceptance test 의 behavioral intent 정정 | atlas / forge (Specification) + human approval |

후속 milestone 이 이전 결정과 충돌하면 최신 결정이 우선한다. 단, 이전 결정의 거부 사유와 새 결정의 사유를 함께 기록한다.

<a id="KAC-CONTEXT-SUMMARY"></a>
## KAC-CONTEXT-SUMMARY: Context Summary

Context Summary 는 다음 milestone 이 알아야 할 핵심을 짧게 요약한 산출물이다.

outer Validation phase 의 PASS 종착 시 lead contribution (`sentinel`) 이 Context Summary 를 산출하고, Caller 가 manifest 에 첨부한다. Validation phase 는 merged spec 과 Decision Log 를 요약할 수 있지만 새 제품 결정을 만들지 않는다.

### 필수 내용

- 완료된 milestone 의 사용자 가치
- 변경된 주요 동작
- 유지해야 할 결정
- 후속 milestone 에서 주의할 리스크
- 관련 AC-ID 와 slice 요약 (slice_id, slice_kind, validated_revision)
- 진행 중 RefactorBacklog 의 architectural debt 지표 (다음 milestone 의 Discovery 에 inject 될 수 있도록)

<a id="KAC-TRACEABILITY"></a>
## KAC-TRACEABILITY: Acceptance Criteria Traceability

outer Specification phase 는 수용 기준마다 안정적인 AC-ID 를 부여한다.

outer Planning phase 는 각 slice 가 어떤 AC-ID 를 구현하는지 mapping 한다 (feature slice 한정 — internal slice 는 declared_metric_threshold 매핑). outer Validation phase 는 결과를 AC-ID 별로 보고한다.

### Minimum Mapping

```text
AC-ID -> Slice ID(s) -> SliceMerge ID(s) -> VerificationRun ID(s) -> Validation verdict
```

`internal` slice 의 경우 acceptance test 매핑 대신:

```text
RefactorProposal ID -> Slice ID -> SliceMerge ID -> MetricRun ID(s) -> Validation verdict
```

AC-ID 가 구현 slice 에 연결되지 않으면 outer Planning phase FAIL 이다. outer Validation phase 가 AC-ID 별 PASS/FAIL 을 보고하지 않으면 Validation phase FAIL 이다.

<a id="KAC-CONFLICTS"></a>
## KAC-CONFLICTS: Conflict Policy

충돌 우선순위:

1. 현재 사람 승인 시그널 (또는 `human_approval` contribution)
2. 최신 병합 스펙
3. 최신 Decision Log
4. 진행 중 Delivery 의 slice telemetry (Discovery N+1 한정)
5. 이전 milestone 산출물

단, 최신 결정이 이전 결정을 뒤집는 경우 `supersedes` 관계와 사유를 기록해야 한다.

<a id="KAC-EQUIVALENCE"></a>
## KAC-EQUIVALENCE: Code and Spec Equivalence

스펙 문서는 코드와 동등한 1급 산출물이다. 다만 finalization 정책은 비대칭이다.

- Spec CP (outer Discovery / Specification 산출) 는 outer phase 의 session termination (필수 `human_approval` contribution 포함) 을 거친다.
- SliceMerge (`feature` slice) 는 middle review 의 `any_request_changes_blocks` finalization + `verification_green` evidence 를 거친다.
- SliceMerge (`internal` slice) 는 middle review 의 `quorum_then_lead` finalization + `verification_green + metric_threshold + interface_diff_clean` evidence 를 거친다.

세 산출물 모두 revision pin, idempotency key, ledger 기록의 대상이다.

<a id="KAC-SESSION-LOG-STORAGE"></a>
## KAC-SESSION-LOG-STORAGE: Session Log Storage

각 DialogueSession 의 turn_log 는 영속 저장소에 *분리된* artifact 로 영속화된다 — session_log 의 size 가 session 본체 metadata 와 묶이면 manifest size 가 폭증하기 때문이다.

### Storage Layout

```text
session_log/
  <session_id>/
    metadata.json              # session 본체 metadata (참조용)
    turns/
      <turn_index>.json        # SessionTurn 1건의 envelope + caller_routing_decision + workspace_commit + verification_result
    snapshots/
      <snapshot_id>.json       # KAC-TURN-LOG-COMPACTION 의 압축 결과
    finalization.json          # CONVERGED / TIMEOUT / ABANDONED / AWAITING_REVALIDATION + final_verdict
```

### Reference 규칙

- DialogueSession.turn_log_ref 는 `session_log/<session_id>/` 디렉토리 식별자.
- Manifest entry 는 turn 단위 또는 snapshot 단위로 fetch_scope=`body+turn_log` 또는 `body+comments` 로 노출.
- 다른 객체 (slice, slice_merge, milestone) 의 audit_chain 은 session_log_ref 를 통해 연결.
- `verification_result` 본문은 `docs/contracts/reliability-and-gate-contract.md#RGC-VERIFICATION` 의 VerificationRun 객체로 영속화되며, SessionTurn 은 그 식별자만 참조한다. 본 절은 verification_result 의 storage 자체를 정의하지 않는다.

### Retention

- M_DONE 또는 M_ESCALATED 도달 시점부터 session_log 는 archive 영역으로 이동 (운영 결정 — 본 contract 는 retention 정책 자체를 강제하지 않음).
- 단 audit_chain 무결성 보존을 위해 session_log_ref 가 가리키는 path 는 invalidation 되지 않아야 한다.

<a id="KAC-TURN-LOG-COMPACTION"></a>
## KAC-TURN-LOG-COMPACTION: Turn Log Compaction

DialogueSession 의 turn_log 는 turn 이 누적되면 manifest size + LLM 호출 token 비용을 폭증시킨다. 본 절은 *수렴적* 압축 정책을 정의한다.

### Compaction 트리거

| Trigger | Threshold (default — TCC override 가능) |
|---|---|
| Turn 누적 수 | 10 turn |
| Turn_log 크기 | 50 KB (이전 snapshot + 최근 raw turn 의 합) |
| Wall-clock | session 시작 후 30 분 |

compaction 의 *실행 주체* 는 dialogue coordinator (Caller 의 session 진행 daemon) 다. 본 trigger 중 하나라도 hit 한 시점의 가장 가까운 finalization 평가 (`#SOC-SESSION-LIFECYCLE` 의 turn 종료 직후) 또는 session_finalize 직전에 동기적으로 실행된다. turn worker 와 agent 는 compaction 을 수행하지 않는다.

### Compaction 알고리즘

1. 직전 snapshot (있을 때) + 직전 snapshot 이후의 raw turn 들을 입력.
2. 다음을 *결정적으로* 추출:
   - 각 turn 의 (turn_index, agent_profile, contribution_kind, summary)
   - lead_draft / review_verdict / proposal contribution 의 verdict 또는 핵심 결정
   - tdd_phase 와 verification_result.failed[] (inner loop)
   - `next_action_request.intent`
3. raw turn 의 본문 (envelope artifacts 등) 은 snapshot 에 포함하지 않으며, snapshot 은 본문 참조 (envelope_ref) 로만 referenced.
4. snapshot 영속화 → snapshot_id 발급.
5. 다음 turn manifest 는 raw turn 의 합 대신 *snapshot + 가장 최근 raw turn(들)* 만 포함.

### Manifest Entry

```text
{
  object_kind: "session_log_snapshot",
  object_id: <snapshot_id>,
  fetch_scope: "body+turn_log",
  revision_pin: <snapshot_audit_hash>,
  required: true,
  purpose: "prior_turn_log_snapshot for turn_index <next>"
}
```

### 무결성

- snapshot 자체는 immutable. 새 snapshot 이 발급되어도 기존 snapshot 은 유지 (audit chain 보존).
- snapshot 의 audit_hash 가 manifest 의 entry revision_pin 으로 사용되어 변형 검출.

### TCC Override

- `target.turn_log_compaction.turn_threshold`
- `target.turn_log_compaction.size_threshold_kb`
- `target.turn_log_compaction.wallclock_minutes`

위 값이 없으면 시스템 default 가 적용된다.

<a id="KAC-REFACTOR-BACKLOG"></a>
## KAC-REFACTOR-BACKLOG: Refactor Backlog

RefactorProposal 과 RefactorBacklog 는 본 contract 의 1급 객체다. SOC 의 workflow 객체와 분리되어 *지식 누적* 영역에 속한다.

### RefactorProposal Schema

```text
RefactorProposal {
  proposal_id
  proposed_at
  proposed_by              # agent_profile_id (scout / forge / sentinel) 또는 human
  status                   # PROPOSED | CURATED | SCHEDULED | DONE | DROPPED | SUPERSEDED
  scope                    # affected milestone / module / file
  suggested_refactor       # 한 문장
  rationale                # debt 종류 (complexity, churn, security, perf 등) + 근거
  code_location            # path/glob
  metric_target            # MetricRun 의 expected threshold
  evidence_refs[]          # MetricRun, VerificationRun, 또는 직전 SliceMerge audit chain 참조
  spawning_slice_id        # SCHEDULED 시 internal slice 의 식별자 (역참조)
  audit_hash
}
```

### RefactorBacklog 의 Lifecycle

```text
PROPOSED      (scout 정기 scan 또는 ad-hoc proposal contribution 산출 직후)
   → CURATED  (Planning ensemble session 의 atlas 가 curation 후 — 우선순위 책정)
   → SCHEDULED (Planning 의 plan_accept 시 internal slice promotion 직후)
   → DONE     (spawning_slice 가 SLICE_VALIDATED 도달)
   |  DROPPED (atlas 가 drop 결정 — 사유는 Decision Log)
   |  SUPERSEDED (다른 proposal 이 본 proposal 의 scope 를 흡수)
```

### Producer

| Producer | 시점 |
|---|---|
| scout | 정기 scan (target.refactor_metrics.scan_interval) — code complexity, churn, test coverage drop, perf regression 등 |
| forge | inner loop 또는 middle review 중 ad-hoc — 작업 도중 발견한 architectural debt |
| sentinel | middle review 중 ad-hoc — review 시 발견한 design smell |

### Curation 책임

Planning ensemble session (`SOC-OPERATIONS#outer-planning`) 의 atlas 가 PROPOSED 후보를 검토하여 CURATED 로 승격하거나 DROPPED 처리. CURATED 후보 중 본 milestone 에 포함할 항목을 internal slice 로 promotion (`SOC-SLICE-CLASS`).

### Inject 정책

Discovery N+1 manifest 에 *RefactorBacklog 의 architectural_debt 지표* 가 inject 된다 — 다음 milestone 의 Discovery 가 architectural debt 를 인식하고 scope 결정에 반영하도록.

<a id="KAC-SLICE-TELEMETRY"></a>
## KAC-SLICE-TELEMETRY: Slice Telemetry Inject

dual-slot serialization 의 핵심 invariant — Discovery N+1 의 manifest 는 진행 중 Delivery N 의 slice telemetry 를 read-only 로 inject 한다.

### Telemetry Schema

```text
SliceTelemetry {
  telemetry_id
  milestone_id              # Delivery N 의 milestone_id
  generated_at
  in_progress_slices[]      # {slice_id, slice_kind, state, current_session_id}
  validated_slices[]        # {slice_id, slice_kind, validated_revision}
  blocked_slices[]          # {slice_id, slice_kind, abandoned_reason}
  recent_session_outcomes[] # {session_id, parent_loop, final_verdict, finalized_at}
  edge_cases[]              # 자주 발생한 verification 실패 패턴 (inner session_log 요약)
  recent_metric_runs[]      # 최근 MetricRun 결과
  audit_hash
}
```

### 생성 주기

`target.dual_track.telemetry_refresh_interval` (default: 30분 또는 Delivery N 의 slice 상태 변경 시점) 마다 Caller 가 새 SliceTelemetry 를 영속화하고 manifest 에 inject.

### Read-only Reference

Discovery N+1 의 session 은 SliceTelemetry 를 *read-only* 만 참조한다. 변경은 SOC-CROSS-MILESTONE-REFERENCE 의 cross_milestone_amendment signal 로만 가능.

telemetry 의 audit_hash 가 변경되면 N+1 의 영향 받은 session 이 자동 AWAITING_REVALIDATION 으로 전이 (`#RGC-CROSS-SLOT-STALE`).

### 만료

Delivery N 이 M_DONE 도달 시 telemetry 는 Context Summary 로 응축되어 manifest 에 일원화. 별도 SliceTelemetry artifact 는 archive 영역으로 이동.
