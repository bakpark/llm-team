# Context Snapshot

본 문서는 [`docs/contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 `fetch_scope` 와 트렁케이션 책임을 구현에 매핑한다. contract 의 의미를 재정의하지 않으며, *어디서 어떻게 적용되는가* 만 기록한다.

## 1. fetch_scope 구현 매핑

[`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 `fetch_scope ∈ {metadata, body, body+comments, tree}` 는 다음 위치에서 적용된다.

- `lib/context.sh` `context_manifest_create()` 가 manifest entry 단위로 `fetch_scope` 를 받아 entry metadata 에 기록.
- `context_manifest_add_entry()` 가 issue-tracker adapter 의 snapshot getter 를 호출. 어댑터(`adapters/issue_tracker/github.sh` 등)는 `fetch_scope` 에 따라 GraphQL projection 을 좁힌다.
  - 단, `fetch_scope=tree` 는 본문 snapshot/truncation 대상이 아니다. cwd mount 의미이며, workspace port(`ws_ensure_ro_tree`)가 read-only code tree를 보장하고 `agent_workspace_for()` 가 symlink 를 생성한다.
- snapshot 직렬화 시점에 revision pin(예: `headSha`, `updatedAt`) 이 같은 entry 안에 함께 저장된다. 이 pin 은 [`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 매 호출 후 *재검증* 입력이다.

## 2. contribution_kind 별 default scope

[`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 의 default 표를 구현이 그대로 따른다.

| `contribution_kind` | 기본 fetch_scope | 비고 |
|---|---|---|
| `lead_draft` | `body` | 새 산출 작성에는 본문이 충분 |
| `lead_draft` (code_tree mount) | `tree` | target codebase read-only mount. 본문 snapshot/truncation 대상 아님 |
| `rework_patch` | `body+comments` | 직전 review_verdict 코멘트가 1급 입력 |
| `review_verdict` | `body+comments` | 결정적 검증 로그 + 직전 contribution 코멘트가 판단 입력 |
| `evidence` | `body+comments` | 실패 맥락 / 사람 보고 코멘트 |
| `summary` | `body+comments` | Validation phase 의 누적 코멘트 흡수 |
| `human_approval` | `body` | 사람 검토 시점의 본문이 1차 입력 |

위 default 는 호출자가 명시적으로 더 좁힐 수 있다. 더 넓힐 때는 manifest entry 단위 명시가 필요하다. phase 별 override 는 `phase_policies.<phase>.fetch_scope_overrides` 가 우선한다.

## 3. 트렁케이션 책임

contract 는 *Caller 가 자른다* 만 정의하고 한도값은 정의하지 않는다. 구현은 다음 layering 으로 처리한다.

1. **fetch 단계**: 어댑터가 GraphQL/REST 응답에서 *원본 그대로* 본문을 받는다. 어댑터는 자르지 않는다.
2. **manifest 작성 단계**: `context_manifest_add_entry()` 가 entry 본문 길이를 임계 이상이면 truncated 표지와 함께 잘라 저장한다. 임계값의 위치(환경변수, target.yaml, 코드 상수 중 어디인가)는 운영 환경 구현이 결정하며, 본 contract 는 그 위치를 강제하지 않는다.
3. **prompt 합성 단계**: prompt 합성기는 manifest 가 이미 잘린 상태라고 가정하고 추가 자름을 하지 않는다.

이 순서는 *agent 가 자른 본문을 다시 자르지 않게* 하기 위함이다. agent 측은 받은 본문을 모두 사용한다([`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST)).

## 4. 운영적 함의

- 트렁케이션 한도값은 운영 결정이며 contract 가 강제하지 않는다. 한도 변경은 manifest hash 의 분포만 바꾸고 다른 invariant 에 영향을 주지 않는다.
- `fetch_scope=body+comments` 의 코스트가 큰 contribution_kind (`review_verdict`, `summary` 등) 에서는 comments 페이지네이션 한도를 만지지 않는다. 누락된 댓글로 의사결정을 하면 reviewer drift 의 원인이 된다.
- manifest entry 의 revision pin 이 호출 후 변경된 것이 확인되면([`#AGC-CONTEXT-MANIFEST`](../contracts/agent-and-context-contract.md#AGC-CONTEXT-MANIFEST) 재검증), Caller 는 결과를 [`#RGC-LEDGER`](../contracts/reliability-and-gate-contract.md#RGC-LEDGER) 의 `stale` 로 분류하고 dispatch 를 건너뛴다.
