# Agent Runner Adapters

본 문서는 [`docs/contracts/agent-runner-port-contract.md`](../contracts/agent-runner-port-contract.md) 의 포트를 만족하는 구체 어댑터의 자리와 매핑 규칙을 기록한다. contract 가 정의한 시그니처 ([`#ARC-PORT-SIGNATURE`](../contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE)), 호출 의미 ([`#ARC-CALL-SEMANTICS`](../contracts/agent-runner-port-contract.md#ARC-CALL-SEMANTICS)), 종료 분류 ([`#ARC-EXIT-CLASSES`](../contracts/agent-runner-port-contract.md#ARC-EXIT-CLASSES)), 교체 invariant ([`#ARC-ADAPTER-SUBSTITUTION`](../contracts/agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION)) 를 *어디서* 만족시키는가만 다룬다.

## 1. 디렉토리 매핑

```text
adapters/
  llm_runner/
    claude_code.sh   ← Claude Code CLI 어댑터 (현재 default)
    fake.sh          ← 결정성 테스트용 fixture 어댑터
```

새 어댑터 (예: `qwen36`, `gpt55`, `github_human_signal`) 는 `adapters/llm_runner/<id>.sh` 로 추가한다. 어댑터 식별자는 [`docs/contracts/target-config-contract.md#TCC-AGENT-PROFILES`](../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.<id>.runner` 값과 일치해야 한다.

`human` AgentProfile 의 runner 는 사람 신호 입력 어댑터 (예: `github_human_signal`) 로, GitHub Issue comment command (REST `/issues/{n}/comments`, node_id prefix `IC_`) 입력을 contribution envelope 으로 변환한다 ([`사람·GitHub 경계 spec`](../superpowers/specs/2026-05-06-human-github-boundary-contract-design.md) §4.1).

## 2. 진입 함수와 포트 시그니처 매핑

각 어댑터는 동일한 진입 함수를 export 한다. contract 의 입출력 항목은 다음과 같이 매핑된다.

| Contract 입력 ([#ARC-PORT-SIGNATURE](../contracts/agent-runner-port-contract.md#ARC-PORT-SIGNATURE)) | 어댑터 인자 |
|---|---|
| `agent_profile_id` | AgentProfile id (`atlas` / `forge` / `sentinel` / `scout` / `human`) |
| `session_id` | Caller 가 발급한 DialogueSession 식별자 |
| `turn_index` | session-local turn 인덱스 |
| `parent_loop` | `outer` / `middle` / `inner` (envelope 메타로 pass-through) |
| `purpose` | session purpose (envelope 메타로 pass-through) |
| `agent_role_in_session` | `lead` / `reviewer` / `observer` |
| `session_context_ref` | 직전 turn_log_snapshot + 직전 verification_result 합성 본문의 영속 위치 |
| `manifest_id` | `lib/context.sh` `context_manifest_id()` 가 반환한 식별자 |
| `prompt_ref` | `prompts/` 하위 경로 (`(parent_loop, phase|purpose, contribution_kind, agent_profile)` 별 prompt) |
| `agent_cwd` | `lib/worktree.sh` 가 만든 격리 디렉토리 경로 (inner tdd_build 한정 — mutable). 그 외 turn 의 workspace 적용 매트릭스는 [`worktree-pr-lifecycle.md`](worktree-pr-lifecycle.md) §3 |
| `timeout` | 초 단위 정수 |
| `idempotency_key` | Caller enrichment 가 합성 — per-turn scope (`session_id + turn_index + agent_profile_id + manifest_id + ...`) |

legacy `phase_run_id`, `agent_role`, `operation` 입력은 폐기되었다.

| Contract 출력 | 어댑터 결과 |
|---|---|
| `exit_status` | 어댑터 종료 코드 → `lib/ports/llm_runner.sh` `lr_classify_exit` 가 contract enum 으로 매핑 |
| `envelope_ref` | 어댑터가 stdout 또는 파일 경로로 반환 |
| `diagnostics_ref` | 어댑터의 stderr 로그 파일 경로 |
| `consumed_at` | 호출 종료 timestamp (어댑터가 기록하지 않으면 caller 가 기록) |

## 3. session_context_ref 합성과 stdin 결합

adapter 는 `prompt_ref` 와 `session_context_ref` 의 본문을 합쳐 stdin 으로 받는다. adapter 는 `session_context_ref` 를 자체적으로 fetch 하지 않으며, Caller 가 `lib/context.sh` 에서 합성한 결과를 그대로 사용한다. 합성 본문의 구체 형식은 [`prompt-build-pipeline.md`](prompt-build-pipeline.md) 가 정의한 4-part canonical layout (YAML frontmatter + sectioned markdown) 을 따른다 — adapter 는 해당 layout 을 보존한다 ([`ARC-ADAPTER-PROMPT-CONTRACT`](../contracts/agent-runner-port-contract.md#ARC-ADAPTER-PROMPT-CONTRACT)).

session_context_ref 의 본문은 다음을 포함:

- 직전 turn_log_snapshot ([`#KAC-TURN-LOG-COMPACTION`](../contracts/knowledge-contract.md#KAC-TURN-LOG-COMPACTION) 의 압축 결과)
- 직전 verification_result (inner loop 한정 또는 evidence 가 직전 turn 에서 발생했을 때)
- 누적 session artifacts (lead artifact / review_verdict / proposal — `body+turn_log` fetch_scope)

### 3.1 Adapter 별 4-Part Wrap

provider 별 role-splitting 처리는 [`prompt-build-pipeline.md`](prompt-build-pipeline.md) §7 의 매핑을 따른다 — header echo 7 필드 invariant ([`AGC-PROMPT-SERIALIZATION`](../contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION)) 는 어떤 wrap 에서도 보존된다.

| Adapter | 4-part wrap |
|---|---|
| `claude_code` | stdin 본문을 단일 prompt 로 forward (role 분리 없음) |
| `codex` 류 (가정) | system: frontmatter + `# Output Schema` / user: `# Context` + `# Instruction` |
| `fake` | frontmatter 의 7 필드 파싱 → fixture envelope echo |

provider-native 응답 → AGC-OUTPUT envelope 의 normalize 매트릭스는 [`AGC-LLM-NEUTRALITY`](../contracts/agent-and-context-contract.md#AGC-LLM-NEUTRALITY) 가 단일 권위.

## 4. 종료 분류 매핑

[`#ARC-EXIT-CLASSES`](../contracts/agent-runner-port-contract.md#ARC-EXIT-CLASSES) 의 5 분류는 어댑터의 raw 종료 신호를 다음 규칙으로 흡수한다.

| Contract 분류 | 어댑터 raw 신호 |
|---|---|
| `ok` | 0 종료 + envelope 본문 출력 |
| `timeout` | timeout 신호 또는 wall-clock 한도 초과 |
| `transport_error` | 네트워크/RPC 실패 종료 |
| `adapter_unavailable` | 인증 실패, 바이너리 미설치 등의 사전 점검 실패 |
| `malformed_output` | 0 종료지만 envelope 본문이 파싱 불가 |

분류 불가능한 종료 (예: 강제 종료) 는 contract 가 정의한대로 caller 가 timeout 또는 transport_error 로 흡수한다.

## 5. fake 어댑터의 위치

`adapters/llm_runner/fake.sh` 는 fixture 응답을 그대로 envelope 으로 출력한다. 이 어댑터는 [`#ARC-ADAPTER-SUBSTITUTION`](../contracts/agent-runner-port-contract.md#ARC-ADAPTER-SUBSTITUTION) 의 *결과 분포 비교 가능* invariant 를 만족하지 않을 수 있으며 (같은 manifest 에 대해 항상 같은 응답을 반환), 그 사실 자체를 *contract 위반이 아니라 테스트 목적의 의도된 좁은 분포* 로 본다. 운영 환경에서는 사용하지 않는다.

Stage 3a (Fake Runner MVP) 는 fake 어댑터의 envelope schema 가 real 어댑터의 *superset* 임을 보장한다 — real 어댑터는 fake 통과 envelope 을 그대로 산출 가능해야 한다 (`docs/superpowers/specs/2026-05-05-loop-based-workflow-design.md` §14).

## 6. agent-profile 매핑 흐름

**Contract intent**: [`#TCC-AGENT-PROFILES`](../contracts/target-config-contract.md#TCC-AGENT-PROFILES) 의 `agent_profiles.<id>.runner` lookup 결과를 caller 가 어댑터 진입 함수로 분기한다. [`#TCC-LOOP-POLICIES`](../contracts/target-config-contract.md#TCC-LOOP-POLICIES) 가 (loop, phase|purpose) 별 lead / participants / required_participants 의 AgentProfile id 를 결정하고, 그 id 가 본 매핑 lookup 의 입력이 된다. 같은 cycle 내에서 같은 AgentProfile 은 항상 같은 어댑터에 매핑된다 (런타임 중 매핑 변경 없음). 매핑 변경은 [`#TCC-CHANGE-RULES`](../contracts/target-config-contract.md#TCC-CHANGE-RULES) 에 따라 다음 cycle 부터 반영된다.

모델명 (예: `claude-opus-4-7`, `codex-qwen-3-6`) 은 본 contract 어디에도 등장하지 않으며 `agent_profiles.<id>.model` 에서만 권위를 갖는다. 어댑터는 자신이 호출할 모델을 본 키에서 읽는다.

**현재 상태 (TBD)**: active binding 은 후속 implementation PR 의 책임이다. 자세한 상태는 [`adapter-inventory.md`](adapter-inventory.md) §5 Open Items 를 참조한다.

## 7. Idempotency 와 adapter

adapter 자체는 idempotency 보장을 하지 않는다. 3-scope idempotency ([`#ARC-IDEMPOTENCY`](../contracts/agent-runner-port-contract.md#ARC-IDEMPOTENCY)) 의 per-turn dedup 은 ledger lookup 으로 caller 가 수행한다 — 선행 `ok` envelope 을 발견하면 adapter 호출 자체를 skip 한다. per-session-outcome 과 per-merge scope 는 dialogue_coordinator 와 trunk merge step 이 책임지며, adapter 는 이 두 scope 를 보지 않는다.
