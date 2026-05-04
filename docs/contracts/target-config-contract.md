# Target Configuration Contract

본 문서는 Caller가 다루는 *target* 의 설정 스키마를 정의한다. target은 영속 저장소의 한 작업 영역에 대응하는 식별 단위이며, Caller의 큐·lease·onboarding·agent runner 매핑이 모두 target 단위로 분기된다.

권한 경계는 `llm-team.md`가 우선한다. 상태/operation/lease 메커닉은 `docs/contracts/state-and-operation-contract.md`, `docs/contracts/reliability-and-gate-contract.md`가 정의한다.

<a id="TCC-SCOPE"></a>
## TCC-SCOPE: Scope

이 문서의 authoritative scope는 다음이다.

- target 식별과 영속 저장소 바인딩
- target 단위 lease TTL 정책
- target 단위 onboarding 게이트 설정
- target 단위 agent runner 매핑
- 설정값 우선순위

본 문서는 설정의 *구체 파일 형식* 을 강제하지 않는다. 형식(YAML, TOML, JSON 등)과 파일 경로는 운영 환경별 구현이 결정한다.

<a id="TCC-IDENTITY"></a>
## TCC-IDENTITY: Target Identity

target은 다음 식별자를 가진다.

| 필드 | 의미 |
|---|---|
| `target_id` | 시스템 내에서 유일한 target 식별자. 라벨 prefix, 큐 분기, ledger 필터의 기준 |
| `persistent_store_ref` | target이 바인딩되는 영속 저장소의 추상 참조(repository, project 등). 어댑터 형식은 운영 환경이 결정 |
| `label_prefix` | 영속 저장소가 라벨을 지원할 때 같은 저장소를 공유하는 다른 target과의 격리를 위한 prefix |

`target_id`가 다르면 같은 영속 저장소를 공유하더라도 큐·lease·라벨이 분리된다.

<a id="TCC-LEASE-CONFIG"></a>
## TCC-LEASE-CONFIG: Lease Configuration

target은 lease TTL을 다음 두 키로 표현한다.

| 키 | 의미 |
|---|---|
| `lease.ttl_default` | 명시되지 않은 모든 역할이 사용할 기본 TTL |
| `lease.ttl_by_role` | 역할별 명시적 TTL 매핑. 누락된 역할은 `ttl_default`를 사용 |

값의 단위는 *시간*이며 구체 단위(초/밀리초)는 운영 환경 구현이 결정한다. `0` 또는 음수는 invalid이며, 본 contract는 무한 TTL을 허용하지 않는다.

`lease.ttl_default`와 `lease.ttl_by_role`의 조합에 대한 해석 규칙과 환경 변수 우선순위는 `docs/contracts/reliability-and-gate-contract.md#RGC-LEASE`가 정의한다.

<a id="TCC-ONBOARDING"></a>
## TCC-ONBOARDING: Onboarding Gate

target은 운영 진입 전 점검을 받는다. 본 절은 점검의 *설정 형태* 만 정의하고, 점검 항목 자체는 architecture 영역이 결정한다.

| 키 | 의미 |
|---|---|
| `onboarding.preset` | target이 따르는 점검 묶음의 식별자. 같은 preset을 공유하는 target들은 동일한 점검 집합을 통과해야 한다 |
| `onboarding.skip_flags` | 환경적으로 비활성화하는 점검 항목의 식별자 집합. 명시적으로 합의된 항목만 허용 |

`onboarding.skip_flags`는 사람의 governance 결정 결과를 설정으로 흘려넣는 통로다. 운영 의도가 명확하지 않은 비활성화는 invariant 위반으로 본다.


<a id="TCC-AGENT-RUNNER-MAP"></a>
## TCC-AGENT-RUNNER-MAP: Agent Runner Map

target은 역할마다 어떤 agent runner adapter를 사용할지 매핑한다.

| 키 | 의미 |
|---|---|
| `agent_runner.default` | 모든 역할이 명시 없이 사용할 기본 adapter 식별자 |
| `agent_runner.by_role` | 역할별 adapter 식별자. 누락된 역할은 `default`를 사용 |

adapter의 시그니처와 호출 의미는 `docs/contracts/agent-runner-port-contract.md`가 정의한다. 본 contract는 *어떤 역할이 어떤 adapter에 매핑되는가* 만 다루며, adapter 자체의 인터페이스는 정의하지 않는다.

<a id="TCC-PRECEDENCE"></a>
## TCC-PRECEDENCE: Configuration Precedence

같은 키에 대해 여러 출처가 값을 제공할 때 우선순위는 다음과 같다.

1. worker별 환경에서 명시적으로 지정된 값
2. target 단위 설정(`TCC-LEASE-CONFIG`, `TCC-ONBOARDING`, `TCC-AGENT-RUNNER-MAP` 등)
3. 시스템 기본값

상위 출처가 명시적으로 빈 값을 설정하면 *제거* 가 아닌 *명시적 빈 설정* 으로 본다. 이는 `TCC-ONBOARDING.skip_flags` 같이 명시성이 invariant인 키에 특히 중요하다.

<a id="TCC-CHANGE-RULES"></a>
## TCC-CHANGE-RULES: Change Rules

target 설정의 변경은 운영 결정이며 다음을 따른다.

- target 식별자(`target_id`, `persistent_store_ref`, `label_prefix`)는 변경 시 영속 저장소 재할당과 ledger 분리가 필요하다. 동일 target_id의 의미를 도중에 다른 저장소로 옮기는 것은 invariant 위반이다.
- `lease`, `onboarding`, `agent_runner` 키는 다음 cycle 시작 시점부터 적용된다. 진행 중인 lease는 이전 설정으로 끝까지 처리된다.
- 변경 자체는 `docs/contracts/reliability-and-gate-contract.md#RGC-LEDGER`에 기록되어야 한다.
