# archive/shell — reference only

이 디렉토리는 `llm-team` 의 **구 shell-script 기반 구현** 을 보관한다. 더 이상 active codebase 가 아니며, 새 구현은 [`docs/`](../../docs/) 의 contract / architecture 문서를 기준으로 다른 언어로 재작성된다.

## 상태

- **폐기됨 (deprecated).** 빌드·실행·테스트 대상이 아니다.
- contract 정합성 (docs/contracts/) 의 authoritative 출처가 아니다. 충돌 시 docs 가 우선한다.
- 코드 변경을 받지 않는다. 새 기능과 버그 수정은 모두 새 구현 트리에서 진행한다.

## 보관 이유

새 구현이 docs 의 contract 를 충족시키는 과정에서, 기존 shell 구현이 어떤 방식으로 동작·운영·검증되었는지 참고할 수 있도록 형태와 history 를 그대로 둔다.

## 구성

| 경로 | 역할 |
|---|---|
| `bin/`, `scheduler/`, `scripts/` | CLI · runner · 설치 / onboarding 스크립트 |
| `application/`, `lib/`, `adapters/` | Caller use-case · helper · GitHub/LLM/notifier adapter |
| `prompts/` | 7 개 Agent 역할 prompt (.md) |
| `targets/` | Target 설정 샘플 |
| `tests/` | bash / contract 테스트 |

docs 내부의 `application/...sh`, `lib/...sh`, `adapters/...sh` 같은 경로 참조는 이 archive 트리를 가리킨다. 새 구현이 자리 잡으면 docs 의 매핑이 갱신된다.
