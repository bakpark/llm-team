# Self-Hosting

본 문서는 [`docs/contracts/target-config-contract.md#TCC-ONBOARDING`](../contracts/target-config-contract.md#TCC-ONBOARDING) 의 `onboarding.self_hosting` 옵션이 구현에서 어떤 의미를 가지는지 기록한다. self-hosting 의 *의도* 와 *안전 장치* 만 다루며, contract 가 정의한 invariant 를 재정의하지 않는다.

## 1. 의미

`onboarding.self_hosting=true` 인 target 은 *Caller 자기 자신의 코드* 가 영속 저장소가 되는 구성이다. 즉, framework 의 worktree 가 framework 자체의 clone 이며, Agent 가 산출하는 patch 가 framework 코드에 적용된다.

`targets/llm-team.yaml` 이 본 저장소의 self-hosting 인스턴스다.

## 2. 진입 가드

self-hosting target 은 추가 가드가 [`#TCC-ONBOARDING`](../contracts/target-config-contract.md#TCC-ONBOARDING) 에 의해 요구된다. 구현은 `application/onboarding/` 의 checklist preset 에 포함시킨다.

| 가드 | 위치 | 목적 |
|---|---|---|
| 회귀 검증 게이트 | `application/onboarding/checklists/` | 자기 자신을 수정한 patch 가 머지되기 전 테스트 통과 확인 |
| ws_apply_patch 절대경로 가드 | `application/agent_workspace.sh` | worktree 외부 경로의 patch 적용 차단 |
| daemon atomic 시작 | [`#RGC-DAEMON-STARTUP`](../contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) | self-hosting 환경에서 부분 기동된 worker 가 자기 자신을 수정하는 race 차단 |

## 3. Hot-reload 미지원

framework 의 코드가 갱신되어도 *현재 cycle 의* worker 는 갱신을 인지하지 않는다. 갱신은 다음 daemon 재기동 시에 반영된다. 이는 [`#RGC-DAEMON-STARTUP`](../contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) 의 atomic 시작 invariant 와 결합되어 *반쯤 갱신된 코드로 cycle 이 도는 상황* 을 막는다.

운영적 함의:

- self-hosting 환경에서는 `bin/` 의 진입 스크립트와 `lib/`/`application/` 의 함수 시그니처를 같은 cycle 에서 동시에 바꾸지 않는다.
- 진행 중인 lease 가 있으면 daemon 재기동을 미루거나, [`#RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE) 의 TTL 만료를 기다린 뒤 재기동한다.

## 4. 사람의 검토가 진입 게이트의 일부

[`#TCC-ONBOARDING`](../contracts/target-config-contract.md#TCC-ONBOARDING) 가 명시하듯 self-hosting 의 안전성은 본 contract 만으로는 보증되지 않는다. 다음은 사람의 명시적 검토가 들어가야 하는 지점이다.

- `bin/`, `lib/`, `application/` 의 변경(패치 머지 전 사람 승인)
- `targets/llm-team.yaml` 자체의 변경(자기 자신의 onboarding 옵션을 자기 자신이 갱신하는 경우)
- `onboarding.skip_flags` 의 추가(invariant 를 우회하는 결정)

## 5. ledger 에서의 식별

self-hosting target 의 ledger 행은 일반 target 과 형식이 같다. 단, 운영 분석 시 `target_id == 자기 저장소` 인지로 필터하면 self-hosting 만의 결과 분포(특히 `rolled_back`/`escalated` 비율)를 분리해 볼 수 있다.
