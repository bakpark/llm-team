# `human` AgentProfile

`human` 은 사람 승인을 session finalization 에 표현하기 위한 특수 AgentProfile 이다. 모델·엔진 개념이 없으며, [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.human.runner` 가 사람 신호 입력 어댑터 (예: `github_human_signal`) 를 결정한다.

사람 결정의 권위는 절대적이며, agent finalization 이 사람 결정을 대체할 수 없다 ([`llm-team.md`](../../../../llm-team.md) Inv #5 — Required human contribution for `feature` slices).

## Scope

- `feature` slice 의 outer Discovery / Specification 에서 필수.
- `internal` slice 가 `target.internal_escalation_rules` ([`#TCC-SLICE-CLASS-RULES`](../../../contracts/target-config-contract.md#TCC-SLICE-CLASS-RULES)) 의 1개라도 hit 시 자동으로 `feature` 게이트로 승격되어 `human` contribution 이 요구된다.

## Trigger (parent_loop · phase / purpose)

`human` 은 `loop_policies.<loop>.<phase|purpose>.required_participants` 에 `human` 이 포함된 step 에서 트리거된다. 표준 권장 사용처:

| Loop · Step | Default contribution_kind | Role |
|---|---|---|
| outer Discovery (feature slice) | `human_approval` | milestone 본문에 대한 사람 승인 / 거부 |
| outer Specification (feature slice) | `human_approval` | scenarios / AC 에 대한 사람 승인 / 거부 |
| middle review (internal escalation hit) | `human_approval` | escalation 사유 검토 + 승인 / 거부 |
| outer Discovery (cross_milestone_amendment) | `human_approval` | N+1 의 발견을 N scope 로 흡수 승인 |

## Contribution 변환 path

사람은 직접 envelope 을 작성하지 않는다. [`#RGC-SIGNALS`](../../../contracts/reliability-and-gate-contract.md#RGC-SIGNALS) 의 `approve` / `reject` 신호 (GitHub label, comment, 또는 별도 form) 가 다음 절차로 contribution 으로 변환된다:

1. `application/human_signal.sh` 가 외부 신호를 drain
2. signal envelope 유효성 검증 (서명, target_revision_pin, related_object_revision_pin, signal_id 중복)
3. `human` profile 의 `human_approval` contribution envelope 으로 변환:
   - `session_id`, `turn_index`: 신호 target session 에서 lookup
   - `agent_profile_id = "human"`, `contribution_kind = "human_approval"`
   - `verdict.result = "approve"` 또는 `"reject"`
   - `summary`, `rationale`: 신호의 `rationale`
4. envelope 을 영속 큐에 enqueue
5. `application/dialogue_coordinator.sh` 가 다음 cycle 에서 finalization 평가에 포함

자세한 권위 보장은 [`#RGC-HUMAN-CONTRIBUTION`](../../../contracts/reliability-and-gate-contract.md#RGC-HUMAN-CONTRIBUTION) 참조.

## Finalization 영향

- `required_participants` 에 `human` 이 있으면 `human_approval` contribution 이 누락된 채 SESSION_OPEN → CONVERGED 로 가지 못한다.
- `verdict.result=reject` 인 `human_approval` 은 finalization rule (`quorum_then_lead`) 의 `human` required 조건에 의해 session 을 차단한다 (다른 reviewer 의 approve 가 reject 를 압도하지 않음).
- 사람 contribution 도착 후 대상 객체가 변했으면 stale 로 판정하고 재승인을 요구한다.

## Worker Slot

`human` 은 일반 worker daemon slot 을 점유하지 않는다. 사람 응답은 외부 governance/input write 로 도착하며, `human_signal_drain` 이 이를 contribution 으로 변환한다. `loop_policies.<loop>.<phase>.timeout` 도과 시 session-timeout recover 가 실행되어 step 이 직전 `*_DRAFT` 로 회수된다.

## Tool Boundary

해당 사항 없음 (사람은 도구를 사용한다 — Caller 가 도구 경계를 강제하지 않는다). Agent boundary 는 `human_signal_drain` 이 변환한 contribution envelope 의 형식 검증으로만 표현된다.
