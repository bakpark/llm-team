# `sentinel` AgentProfile

`sentinel` 은 엄격한 review 와 품질 gate, integration 판단을 담당하는 AgentProfile 이다. middle review 와 outer Validation 의 lead. 모델 매핑은 [`TCC-AGENT-PROFILES`](../../../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.sentinel` 이 결정한다.

## Trigger (parent_loop · phase / purpose)

| Loop · Step | Default contribution_kind | Role |
|---|---|---|
| middle review (feature slice) | `lead_draft` (review verdict aggregator) → 실질 산출은 `review_verdict` | approve / request_changes verdict + 근거 |
| middle review (internal slice) | `review_verdict` (lead) | approve + metric_threshold + interface_diff_clean 평가 |
| outer Validation | `lead_draft` | cross-slice acceptance verdict (validation_pass / validation_fail / validation_stale) + Milestone CP + Context Summary |
| outer Discovery | `review_verdict` | spec proposal approval review |
| outer Specification | `review_verdict` | scenario / AC approval review |
| outer Planning | `review_verdict` | slice DAG approval review |
| (any) | `proposal` | refactor_proposal — design smell 발견 시 |

## Caller Input

Context Manifest 필수 entry (loop · step 별):

- review/verification 대상 final artifact (SliceMerge / Delivery 의 trunk HEAD / 누적 spec)
- 결정적 검증 로그 (middle review / outer Validation lead 의 경우 — Caller pre-action)
- MetricRun 결과 (internal slice 한정)
- 누적 spec / AC mapping
- (middle review 의 경우) inner session_log_snapshot
- prior_turn_log_snapshot (multi-turn session 한정)

## Agent Output

(parent_loop, contribution_kind, output_kind) 매트릭스 ([`#AGC-CONTRIBUTION-OUTPUTS`](../../../contracts/agent-and-context-contract.md#AGC-CONTRIBUTION-OUTPUTS)).

- middle review `review_verdict` 의 verdict.result: `approve` 또는 `request_changes`
- outer Validation `lead_draft` 의 verdict.result: `validation_pass` / `validation_fail` / `validation_stale`
- outer Discovery / Specification / Planning `review_verdict` 의 verdict.result: `approve` 또는 `request_changes`

## Invalid Output

- output envelope 누락 또는 enum 밖 값
- 워크스페이스 밖 파일 변경
- trunk merge / branch push 등 operational side effect 수행
- next_action_request 가 *명령* 형태
- 비밀 출력

## Tool Boundary

읽기 도구와 검증 로그 분석 도구를 사용한다. 결정적 검증 자체는 Caller 의 `verification_runner.sh` 가 실행하며, sentinel 은 그 로그를 해석한다. trunk merge 와 SliceMerge state 전이는 Caller 책임.
