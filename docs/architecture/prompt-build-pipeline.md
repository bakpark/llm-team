# Prompt Build Pipeline

본 문서는 [`AGC-PROMPT-SERIALIZATION`](../contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION) 의 4-part canonical layout 을 *어떤 구체 형식으로* 직렬화하는지 정의한다. contract 본문은 section 순서·echo invariant·책임만 고정하고, 본 문서가 형식을 결정한다.

contract cross-link:
- [`AGC-PROMPT-SERIALIZATION`](../contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION) — 4-part layout, header echo 7 필드
- [`AGC-LLM-NEUTRALITY`](../contracts/agent-and-context-contract.md#AGC-LLM-NEUTRALITY) — provider-native ↔ envelope normalize
- [`AGC-CONTEXT-BUDGET`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-BUDGET) — token budget cap
- [`ARC-ADAPTER-PROMPT-CONTRACT`](../contracts/agent-runner-port-contract.md#ARC-ADAPTER-PROMPT-CONTRACT) — transport 측 보존 invariant

## 1. 4-Part 직렬화 형식

prompt 본문은 **YAML frontmatter + sectioned markdown** 으로 직렬화한다. delimiter 토큰은 다음으로 고정한다.

```text
---
<header section: YAML frontmatter>
---

# Context

<context section body>

# Instruction

<instruction section body>

# Output Schema

<output_schema section body>
```

규칙:

- 첫 줄은 정확히 `---` (3 hyphen, trailing space 없음). 그 다음에 YAML 본문이 오며 다음 `---` 로 닫힌다 — frontmatter 형식은 RFC 의 markdown frontmatter convention 을 따른다.
- frontmatter 직후 빈 줄 1 개, 그 다음 `# Context` heading.
- 각 section heading 은 `#` 단일 (level 1) 로 고정. heading 텍스트는 위 4 개로 정확히 일치 (다른 텍스트 / 영문 대소문자 변경 / level 2 사용은 invalid).
- section 본문은 markdown free form. 코드 블록·표·인용 모두 허용. 단 위 4 개의 heading 텍스트 자체는 본문에 등장해서는 안 된다 (parsing 충돌 방지).

## 2. Header Section (YAML frontmatter)

[`AGC-PROMPT-SERIALIZATION`](../contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION) 의 7 필드 echo invariant 를 다음 키 이름으로 직렬화한다.

```yaml
session_id: <string>
turn_index: <integer>
parent_loop: outer | middle | inner
phase_or_purpose: <string>
agent_profile_id: atlas | forge | sentinel | scout | human
agent_role_in_session: lead | reviewer | observer
manifest_id: <string>
```

추가 키:

```yaml
echo_strict: true
```

`echo_strict: true` 는 agent 가 envelope 의 동명 필드에 위 7 값을 *문자열 동일* 하게 echo 해야 함을 명시한다. envelope parser 는 7 필드의 동일성을 검증하며 불일치는 invalid envelope 으로 분류한다 ([`AGC-INVALID`](../contracts/agent-and-context-contract.md#AGC-INVALID)).

frontmatter 는 위 8 개 키 외 다른 키를 포함해서는 안 된다. 다른 메타가 필요하면 instruction section 의 본문에 작성하거나 prompt template 자체에 정적으로 포함한다.

## 3. Context Section

[`AGC-SESSION-INPUT`](../contracts/agent-and-context-contract.md#AGC-SESSION-INPUT) 의 합성 결과를 다음 sub-block 으로 작성한다.

```markdown
# Context

## Manifest

<context_manifest entries — fetch_scope 에 따라 합성된 본문>

## Prior Turn Log Snapshot

<turn_index >= 2 일 때만; KAC-TURN-LOG-COMPACTION 의 snapshot 본문>

## Prior Verification Result

<inner loop 또는 evidence 가 직전 turn 에서 발생했을 때만; RGC-VERIFICATION 의 VerificationRun 요약>

## Accumulated Session Artifacts

<purpose 별 누적 lead_draft / review_verdict / proposal>
```

조건부 sub-block 은 해당 데이터가 없으면 *섹션 자체를 생략* 한다 (빈 섹션 placeholder 작성 금지).

## 4. Instruction Section

`prompts/<role>.md` 의 자연어 본문을 그대로 삽입한다. prompt 파일은 다음 구조를 권장:

```markdown
# Instruction

<역할 설명>

<현재 turn 의 의도>

<제약 — 변경 금지 영역, scope rules 등>
```

prompt 파일 자체는 `# Instruction` heading 을 포함하지 않으며, 본 pipeline 이 wrapping 단계에서 그 heading 을 추가한다.

## 5. Output Schema Section

`AGC-OUTPUT` envelope 의 JSON schema 를 다음 형식으로 삽입한다.

````markdown
# Output Schema

산출은 단일 ```json fenced block 으로 출력한다. envelope 형식:

```json
{
  "session_id": "...",
  "turn_index": 0,
  "parent_loop": "...",
  "phase_or_purpose": "...",
  "agent_profile_id": "...",
  "agent_role_in_session": "...",
  "contribution_kind": "...",
  "manifest_id": "...",
  "input_revision_pins": [],
  "output_kind": "...",
  "object_id": "...",
  "summary": "...",
  "artifacts": [],
  "verdict": null,
  "next_action_request": null,
  "failure": null
}
```

allowed `output_kind` 와 `verdict.result` 는 `(parent_loop, phase_or_purpose, contribution_kind)` 조합에 따라 다르다 — `AGC-CONTRIBUTION-OUTPUTS` 매트릭스 준수.
````

`runtime_metadata`, `idempotency_key` 는 Caller enrichment 영역이므로 schema 에서 제외 (agent 산출 금지).

## 6. Token Budget 적용 단계

[`AGC-CONTEXT-BUDGET`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-BUDGET) 의 truncation 우선순위는 본 pipeline 에서 다음 순서로 적용한다.

1. fetch_scope=`tree` entry 본문 → 제거
2. `body+turn_log` 의 turn_log → KAC compaction 한도까지 추가 압축
3. `body+comments` 의 comments → 절단
4. `body` 본문 → metadata 만 남기는 형태로 격하
5. `metadata` → 마지막까지 보존

각 단계 적용 후 budget 미달이면 다음 단계를 진행. 5 단계 모두 적용해도 budget 초과 시 `truncation_failure` 분류로 caller 가 turn 을 invalid 처리한다 (silent provider 절단 회피).

hard cap 값은 target 별 `target.context_budget.<loop>.<purpose>.tokens` (TCC) 가 결정. default 는 256k token (architecture default; provider 한도 보다 낮게 설정).

## 7. Adapter 별 Wrap

`adapters/llm_runner/<id>.sh` 는 위 4-part 본문을 stdin 으로 받은 뒤 provider 별로 다음과 같이 처리한다 ([`AGC-LLM-NEUTRALITY`](../contracts/agent-and-context-contract.md#AGC-LLM-NEUTRALITY) 의 role-splitting invariant 보존).

### 7.1 `claude_code` (현재 default)

stdin 본문을 그대로 LLM CLI 의 단일 prompt 로 전달한다. role 분리를 지원하지 않으므로 4 section 을 단일 본문으로 forward.

### 7.2 `codex` 류 (가정)

provider 가 system / user 분리를 요구할 경우 다음 매핑을 권장:

- system: frontmatter (header section) + `# Output Schema` 본문
- user: `# Context` + `# Instruction`

매핑 시 frontmatter 의 7 필드는 system message 의 첫 영역에 그대로 직렬화하여 echo invariant 를 보존한다.

### 7.3 `fake` (테스트용)

stdin 본문에서 frontmatter 의 7 필드를 파싱하여 fixture envelope 의 동명 필드에 그대로 echo 한다. fixture 응답 자체는 `tests/fixtures/agc-envelope-roundtrip/` 의 매핑을 사용한다.

## 8. Caller 책임

prompt 본문 빌드는 `application/caller_dispatch.sh` (또는 그에 상응하는 prompt builder helper) 가 단일 진입점으로 수행한다. 다음 책임을 갖는다:

1. AGC-SESSION-INPUT 의 7 필드 + manifest_id 수집.
2. fetch_scope 별 manifest entry 본문 합성 (token budget 적용).
3. `prompts/<role>.md` 본문 로드 후 `# Instruction` heading wrap.
4. AGC-OUTPUT JSON schema 본문 작성 (`# Output Schema`).
5. 4 section 을 §1 의 delimiter 규칙으로 직렬화.
6. `prompt_ref` 가 가리키는 영속 위치에 atomic write (`persistence-layout.md` §3 의 rename-after-write).
7. ARC-PORT-SIGNATURE 입력으로 caller 에 반환.

adapter 는 위 7 단계 어디에도 개입하지 않는다.

## 9. 마이그레이션 — 현재 prompt 구조와의 차이

현재 `prompts/coder.md` 는 legacy 헤더 3 줄 (`# Role:`, `# Operation:`, `# Manifest-id:`) 구조다. 본 pipeline 은 다음 단계로 마이그레이션한다 (실제 코드 변경은 후속 plan 의 implementation work):

1. `prompts/<role>.md` 는 `# Role:` / `# Operation:` 헤더를 *제거* 하고 자연어 본문만 보존.
2. `lib/ports/llm_runner.sh` 의 `lr_call` 헤더 파싱은 frontmatter 파싱으로 교체.
3. `application/caller_dispatch.sh` 가 4-part wrap 의 단일 진입점이 된다.

본 마이그레이션은 [`docs/superpowers/specs/2026-05-05-loop-based-workflow-design.md`](../superpowers/specs/2026-05-05-loop-based-workflow-design.md) Stage 2 (Implementation Foundation) 에서 contract 변경과 함께 진행한다.
