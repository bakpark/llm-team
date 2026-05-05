# Agent Runner Adapters

본 문서는 [`docs/contracts/agent-runner-port-contract.md`](../contracts/agent-runner-port-contract.md) 의 포트를 만족하는 구체 어댑터의 자리와 매핑 규칙을 기록한다. contract 가 정의한 시그니처(`#ARC-PORT-SIGNATURE`), 호출 의미(`#ARC-CALL-SEMANTICS`), 종료 분류(`#ARC-EXIT-CLASSES`), 교체 invariant(`#ARC-ADAPTER-SUBSTITUTION`) 를 *어디서* 만족시키는가만 다룬다.

## 1. 디렉토리 매핑

```text
adapters/
  llm_runner/
    claude_code.sh   ← Claude Code CLI 어댑터 (현재 default)
    fake.sh          ← 결정성 테스트용 fixture 어댑터
```

새 어댑터 (예: `qwen36`, `gpt55`, `github_human_signal`) 는 `adapters/llm_runner/<id>.sh` 로 추가한다. 어댑터 식별자는 [`docs/contracts/target-config-contract.md#TCC-AGENT-PROFILES`](../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.<id>.runner` 값과 일치해야 한다.

`human` AgentProfile 의 runner 는 LLM 어댑터가 아니라 사람 신호 입력 어댑터 (예: `github_human_signal`) 로, GitHub label/comment 같은 외부 governance/input write 를 contribution envelope 으로 변환한다.

## 2. 진입 함수와 포트 시그니처 매핑

각 어댑터는 동일한 진입 함수를 export 한다. contract 의 입출력 항목은 다음과 같이 매핑된다.

| Contract 입력 ([#ARC-PORT-SIGNATURE](../contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE)) | 어댑터 인자 |
|---|---|
| `agent_profile` | AgentProfile id (`atlas` / `forge` / `sentinel` / `scout` / `human`) |
| `phase` | phase 식별자 문자열 (envelope 메타로 pass-through) |
| `contribution_kind` | contribution_kind 식별자 (envelope 메타로 pass-through) |
| `phase_run_id` | Caller 가 발급한 PhaseRun 식별자 (envelope 메타로 pass-through) |
| `manifest_id` | `lib/context.sh` `context_manifest_id()` 가 반환한 식별자 |
| `prompt_ref` | `prompts/` 하위 경로 (`(phase, contribution_kind, agent_profile)` 별 prompt) |
| `agent_cwd` | `lib/worktree.sh` 가 만든 격리 디렉토리 경로 (lead_draft / rework_patch contribution 에 한함) |
| `timeout` | 초 단위 정수 |
| `idempotency_key` | Caller 가 `phase_run_id` + `agent_profile` + `contribution_kind` + lease_token 등으로 합성한 키 |

| Contract 출력 | 어댑터 결과 |
|---|---|
| `exit_status` | 어댑터 종료 코드 → `lib/ports/llm_runner.sh` `lr_classify_exit` 가 contract enum 으로 매핑 |
| `envelope_ref` | 어댑터가 stdout 또는 파일 경로로 반환 |
| `diagnostics_ref` | 어댑터의 stderr 로그 파일 경로 |
| `consumed_at` | 호출 종료 timestamp(어댑터가 기록하지 않으면 caller 가 기록) |

## 3. 종료 분류 매핑

[`#ARC-EXIT-CLASSES`](../contracts/agent-runner-port-contract.md#ARC-EXIT-CLASSES) 의 5 분류는 어댑터의 raw 종료 신호를 다음 규칙으로 흡수한다.

| Contract 분류 | 어댑터 raw 신호 |
|---|---|
| `ok` | 0 종료 + envelope 본문 출력 |
| `timeout` | timeout 신호 또는 wall-clock 한도 초과 |
| `transport_error` | 네트워크/RPC 실패 종료 |
| `adapter_unavailable` | 인증 실패, 바이너리 미설치 등의 사전 점검 실패 |
| `malformed_output` | 0 종료지만 envelope 본문이 파싱 불가 |

분류 불가능한 종료(예: 강제 종료) 는 contract 가 정의한대로 caller 가 timeout 또는 transport_error 로 흡수한다.

## 4. fake 어댑터의 위치

`adapters/llm_runner/fake.sh` 는 fixture 응답을 그대로 envelope 으로 출력한다. 이 어댑터는 [`#ARC-ADAPTER-SUBSTITUTION`](../contracts/agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION) 의 *결과 분포 비교 가능* invariant 를 만족하지 않을 수 있으며(같은 manifest 에 대해 항상 같은 응답을 반환), 그 사실 자체를 *contract 위반이 아니라 테스트 목적의 의도된 좁은 분포* 로 본다. 운영 환경에서는 사용하지 않는다.

## 5. agent-profile 매핑 흐름

**Contract intent**: [`#TCC-AGENT-PROFILES`](../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.<id>.runner` lookup 결과를 caller 가 어댑터 진입 함수로 분기한다. [`#TCC-PHASE-POLICIES`](../contracts/target-config-contract.md#TCC-PHASE-POLICIES) 가 phase 별 lead / reviewers / required_reviewers 의 AgentProfile id 를 결정하고, 그 id 가 본 매핑 lookup 의 입력이 된다. 같은 cycle 내에서 같은 AgentProfile 은 항상 같은 어댑터에 매핑된다(런타임 중 매핑 변경 없음). 매핑 변경은 [`#TCC-CHANGE-RULES`](../contracts/target-config-contract.md#TCC-CHANGE-RULES) 에 따라 다음 cycle 부터 반영된다.

모델명 (예: `claude-opus-4-7`, `codex-qwen-3-6`) 은 본 contract 어디에도 등장하지 않으며 `agent_profiles.<id>.model` 에서만 권위를 갖는다. 어댑터는 자신이 호출할 모델을 본 키에서 읽는다.

**현재 상태 (TBD)**: active binding 은 미구현이다. `scheduler/runner.sh` 가 `config_agent_runner_for_role` 을 호출하지 않으며, 어댑터 진입은 정적으로 결정된다 (legacy role 기반). AgentProfile 기반 binding 으로의 전환은 후속 implementation PR 의 책임이다. 자세한 상태와 미해결 항목은 [`adapter-inventory.md`](adapter-inventory.md) §5 Open Items 를 single source of truth 로 참조한다.
