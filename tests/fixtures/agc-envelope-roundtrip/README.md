# AGC Envelope Roundtrip Baseline Fixtures

본 디렉토리는 [`AGC-PROMPT-SERIALIZATION`](../../../docs/contracts/agent-and-context-contract.md#AGC-PROMPT-SERIALIZATION) 의 4-part canonical layout 과 header echo invariant 를 검증하기 위한 baseline fixture 다. 실제 fake adapter 통합 테스트의 입력으로 사용된다.

## 목적

contract 가 정의한 invariant:

1. **4-part canonical layout** (`header` → `context` → `instruction` → `output_schema`) 이 prompt 본문에 본 순서로 등장해야 한다.
2. **Header echo invariant (7 필드)** — `session_id`, `turn_index`, `parent_loop`, `phase_or_purpose`, `agent_profile_id`, `agent_role_in_session`, `manifest_id` — 의 값이 envelope 의 동명 필드에 *문자열 동일* 하게 출력되어야 한다.
3. **Token budget overflow** 시 silent 절단이 아니라 invalid envelope 또는 `malformed_output` 분류로 종료되어야 한다 ([`AGC-CONTEXT-BUDGET`](../../../docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-BUDGET)).

본 fixture 는 Stage 3a (Fake Runner MVP, [`docs/superpowers/specs/2026-05-05-loop-based-workflow-design.md`](../../../docs/superpowers/specs/2026-05-05-loop-based-workflow-design.md) §14) 의 fake adapter 가 위 3 invariant 를 만족하는지 baseline 으로 확인한다.

## 디렉토리 구조

```text
agc-envelope-roundtrip/
  README.md                                   # 본 문서
  case-001-inner-tdd-build/
    input.prompt.md                           # 4-part canonical layout 의 stdin 입력 본문
    expected.envelope.json                    # fake adapter 가 반환해야 할 AGC-OUTPUT envelope
    notes.md                                  # 본 케이스가 검증하는 invariant + 의도된 입력 변형
  case-002-middle-review-verdict/
  case-003-header-echo-mismatch-invalid/      # invalid 케이스 — adapter 가 echo 를 깨뜨리면 invalid 로 분류되어야 함
  case-004-truncation-overflow/               # token budget overflow → malformed_output
```

### Case Directory Naming Convention

`case-<NNN>-<loop-or-purpose>-<scenario-slug>/` 형식. 예: `case-001-inner-tdd-build-first-turn`, `case-003-header-echo-mismatch-invalid`. `<NNN>` 은 fixture 추가 순서 (zero-padded 3 digits). invalid / overflow 같은 negative 케이스는 슬러그 끝에 의도된 분류 (`-invalid`, `-overflow` 등) 를 붙인다.

각 케이스 디렉토리는 다음 3 파일을 포함한다:

| 파일 | 의미 |
|---|---|
| `input.prompt.md` | [`prompt-build-pipeline.md`](../../../docs/architecture/prompt-build-pipeline.md) 의 §1 형식으로 직렬화된 4-part 본문. fake adapter 의 stdin 으로 그대로 전달된다 |
| `expected.envelope.json` | adapter 호출 후 envelope parser 가 산출해야 할 정상화된 envelope (또는 invalid 케이스의 기대 분류) |
| `notes.md` | 검증 의도, 의도된 입력의 특성, 기대되는 invariant 위반 분류 |

## 실행 방법 (예정)

본 fixture 의 실제 실행 helper 는 Stage 3a 에서 추가된다. 예상 호출:

```bash
tests/_helpers/fixture_runner.sh \
  --fixture tests/fixtures/agc-envelope-roundtrip/case-001-inner-tdd-build/ \
  --adapter adapters/llm_runner/fake.sh
```

helper 는 다음을 수행한다:

1. `input.prompt.md` 를 stdin 으로 fake adapter 호출.
2. adapter 의 stdout (envelope) 과 exit_status 캡처.
3. expected.envelope.json 과 비교 (header echo 7 필드는 strict equality, 나머지 필드는 schema 검증).
4. invalid 케이스의 경우 envelope parser 의 분류가 expected 와 일치하는지 검증.

## Baseline 케이스 (이 commit 에서 추가)

본 commit 은 baseline 디렉토리 구조와 README 만 신설한다. 실제 fixture 본문 (`input.prompt.md` / `expected.envelope.json` / `notes.md`) 은 Stage 3a (Fake Runner MVP) 에서 prompt-build-pipeline.md 의 형식이 안정화되는 시점에 추가한다 — contract 텍스트 변경에 따라 fixture 가 잘못 재생산되지 않도록 별도 PR 로 분리한다.
