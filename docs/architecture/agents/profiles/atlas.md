# `atlas` AgentProfile

`atlas` 는 고수준 설계와 스펙 정리를 담당하는 AgentProfile 이다. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.atlas` 가 결정한다.

## Trigger (parent_loop · phase / purpose)

| Loop · Step | Default contribution_kind | Role |
|---|---|---|
| outer Discovery | `lead_draft` | milestone 본문 + ADR + spec_proposal |
| outer Specification | `lead_draft` | scenarios + AC-IDs + AC-ID 별 acceptance test 코드 |
| outer Planning | `lead_draft` | slice DAG + 의존 그래프 + RefactorBacklog curation |
| outer Validation | (lead 는 sentinel) | observer / context summary 보조 (운영 결정) |
| middle review (architectural slice) | `review_verdict` | architecture 관점 reviewer |
| (any) | `proposal` | refactor_proposal curation, cross_milestone_amendment |

## Caller Input

Context Manifest 필수 entry (loop · step 별):

- 직전 step 의 final artifact + ADR
- 누적 spec manifest
- 진행 중 Delivery slot 의 SliceTelemetry (Discovery N+1 한정 — `KAC-SLICE-TELEMETRY`)
- RefactorBacklog 의 architectural debt 지표 (Planning curation 시)
- prior_turn_log_snapshot (multi-turn session 한정 — `KAC-TURN-LOG-COMPACTION`)

## Agent Output

(parent_loop, contribution_kind, output_kind) 의 허용 조합은 [`#AGC-CONTRIBUTION-OUTPUTS`](../../../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS) 매트릭스를 따른다. 모든 envelope 은 `session_id`, `turn_index`, `parent_loop`, `agent_profile_id=atlas`, `agent_role_in_session`, `contribution_kind`, `output_kind` 를 포함해야 한다.

## Invalid Output

- 워크스페이스 밖 파일 변경
- output envelope 누락 또는 enum 밖 값
- operational side effect 수행 (slice merge, label 변경 등)
- next_action_request 가 *명령* 형태 (제안만 허용 — `AGC-NEXT-ACTION-REQUEST`)
- 비밀 출력
- legacy `agent_role` / `operation` / `phase_run_id` 필드 사용

## Tool Boundary

읽기 도구만 사용한다. operational write 는 모두 Caller 책임이다. session 안 multi-turn 의 합성은 Caller 가 turn_log_snapshot + verification_result 를 input 으로 만들어 전달한다 — agent 가 자체 메모리를 누적하지 않는다.
