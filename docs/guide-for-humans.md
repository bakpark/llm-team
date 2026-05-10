# LLM Team - 인간을 위한 가이드

이 문서는 `llm-team` 을 처음 읽는 사람이 핵심 모델을 빠르게 이해하기
위한 입문서다. 이 문서는 contract 가 아니다. 이 문서가
[`../llm-team.md`](../llm-team.md) 또는 [`contracts/`](contracts/) 와
충돌하면 상위 문서가 우선한다.

문서 트리의 권위 순서와 전체 색인은 [`README.md`](README.md) 를 따른다.

---

## 1. 한 줄 요약

`llm-team` 은 사람, LLM agent, 결정적 도구, 영속 workflow state 를
분리해서 소프트웨어 작업을 진행하는 모델이다.

핵심 경계는 다음 한 문장이다.

> Agent 는 콘텐츠를 만들고, Caller 는 workflow 전이를 수행하며, 사람은
> governance signal 을 제공한다.

이 분리가 시스템의 핵심이다. agent 가 몰래 state 를 바꾸거나, 코드를
merge 하거나, Issue 를 닫거나, 다른 agent 를 직접 호출하지 못하게 만든다.

## 2. 주체별 책임

| 주체 | 책임 | 금지 |
|---|---|---|
| Human | feature-facing 결정 승인·거부, 회수·중단 요청, 모델 변경 승인 | 정상 제어 경로로 내부 workflow state 를 직접 수정 |
| Agent | 한 호출당 하나의 콘텐츠 산출: spec, patch, review verdict, proposal, summary | state 변경, merge, Issue 생성·종료, lease 획득, 다른 agent 직접 호출 |
| Caller | prompt 합성, agent 호출, 출력 검증, 테스트 실행, lease 관리, workflow state 전이, GitHub mirror 갱신 | 헌법 원칙 또는 결정적 검증 우회 |
| Persistent Store | milestone, slice, session, turn, slice merge, verification run, ledger, external ref 보존 | manifest 규칙 밖의 숨은 agent memory 역할 |

사람과 agent 는 같은 권한을 갖지 않는다. 사람은 governance gate 의 권위자다.
agent 는 유용한 contributor 이지만, Caller 검증과 dispatch 를 통과한 뒤에만
workflow 에 영향을 준다.

## 3. 작업 흐름의 큰 그림

workflow 는 3-loop nested model 이다.

```text
Outer  - milestone 작업
  Discovery -> Specification -> Planning -> Validation

Middle - slice review / integration
  review, request changes, approve, integrate

Inner  - implementation
  forge 의 TDD-style build turn
```

이전 7-phase 모델의 `Implementation`, `CodeReview`, `Integration` 은 더 이상
outer phase 가 아니다. 구현은 inner loop, review 는 middle loop, integration 은
`SliceMerge` lifecycle 이 담당한다.

## 4. 주요 객체

| 객체 | 의미 |
|---|---|
| Milestone | outer loop 를 통과하는 제품 목표 |
| Slice | 사용자 가치 단위 또는 behavior-preserving internal change |
| DialogueSession | 한 loop step 에서 진행되는 turn-based deliberation |
| SessionTurn | session 안의 agent 또는 human contribution 1회 |
| SliceMerge | slice 의 merge candidate |
| VerificationRun | Caller 가 실행한 테스트·검증 증거 |
| Ledger row | workflow 진행 또는 외부 관찰의 append-only 감사 기록 |

중요한 규칙은 단순하다. handoff 는 이 객체들을 통해서만 일어난다. agent memory
나 agent 간 직접 호출은 handoff 수단이 아니다.

## 5. AgentProfile

| Profile | 일반 역할 |
|---|---|
| `atlas` | 제품/spec/design lead, architecture reviewer |
| `forge` | inner TDD build 의 implementation lead |
| `sentinel` | review / validation lead |
| `scout` | observation, evidence, refactor backlog signal |
| `human` | 승인된 사람 governance signal 을 표현하는 synthetic profile |

모델명과 runner 는 target config 의 책임이다. contract 와 헌법은 profile id 를
사용하며, 모델 교체는 core workflow 변경 없이 가능해야 한다.

## 6. 사람 입력 방식

사람은 raw envelope 을 직접 작성하지 않는다. 사람 의도는 governance signal 로
들어오며, 현재 표준 입력은 허용된 GitHub Issue surface 에 작성하는 strict
comment command 다.

대표 command:

```text
/approve <optional rationale>
/reject <optional rationale>
/rework <optional rationale>
/recover <optional rationale>
/pause <optional rationale>
/resume <optional rationale>
/stop <optional rationale>
```

경계가 중요하다.

- 설정된 prefix 로 시작하는 Issue comment 만 signal input 이다.
- PR native review 와 PR inline review comment 는 사람 governance signal 이 아니다.
- label 수정, Issue close/reopen, PR draft toggle 같은 GitHub lifecycle 변경은
  내부 state 전이가 아니라 drift observation 으로 처리된다.

이 정책은 GitHub 를 유용한 협업 표면으로 쓰면서도 내부 state machine 의 권위를
보존하기 위한 것이다.

## 7. GitHub 표면

GitHub 는 내부 workflow 객체의 mirror 다.

| 내부 객체 | GitHub surface |
|---|---|
| Milestone | GitHub Milestone |
| Slice | GitHub Issue |
| SliceMerge | GitHub Pull Request |
| Milestone human gate | Milestone Tracker Issue |
| System control | Control Issue |
| Contract/model governance | Contract Change Issue |

내부 state 가 권위다. GitHub 변경은 Caller 가 outbound 로 쓴다. 사람이 GitHub 에서
직접 바꾼 lifecycle 변경은 drift 로 관찰하고, 필요하면 별도 governance signal 로
회복한다.

## 8. Prompt 와 context

agent 는 한 번에 한 turn 씩 호출된다. Caller 는 다음 입력을 합성한다.

- session, turn, profile, loop, manifest 를 식별하는 frontmatter
- object id, fetch scope, revision pin 을 담은 Context Manifest
- 필요한 경우 inline 된 manifest body
- role / loop / purpose 별 instruction
- output schema 또는 response contract

현재 구현의 관련 위치:

- [`../src/application/prompt-compose.ts`](../src/application/prompt-compose.ts)
- [`../src/application/agent-io.ts`](../src/application/agent-io.ts)
- [`architecture/prompt-build-pipeline.md`](architecture/prompt-build-pipeline.md)

현재 코드베이스에는 별도 `src/prompt/templates/` 디렉토리가 없다.

## 9. Envelope 의 현재 역할

현재 agent output 은 envelope 로 normalize 되고 `SessionTurn` 의 일부로
영속화된다. envelope 는 다음 용도로 쓰인다.

- schema validation
- header echo 검증
- contribution kind / output kind matrix 검증
- verdict 또는 failure 기록
- Caller runtime metadata enrichment
- idempotency 와 ledger correlation

envelope 는 agent 에게 operational authority 를 주지 않는다. envelope 가
"merge" 를 암시하더라도 Caller 는 dispatch matrix 와 deterministic evidence 를
따로 평가한다.

## 10. 현재 설계 압력

2026-05-10 self-hosting run 에서 반복적으로 드러난 약점은 agent 간 review
context 가 내부 SessionTurn body 와 manifest resolver inline 에 지나치게 의존한다는
점이다. resolver 나 store wiring 이 빠지면 agent 는 `need_context` 로 루프를 돌거나
같은 request_changes 를 반복할 수 있다.

현재 유력한 개선 방향은 envelope 의 논의 본문 책임을 줄이고 PR surface 를 durable
review context 로 승격하는 것이다.

- lead agent 는 review 가능한 PR context 를 준비한다.
- reviewer agent 는 PR review 또는 PR comment 형태로 finding 을 남긴다.
- Caller 는 PR thread 를 사람이 읽는 continuity layer 로 사용하되, 내부 receipt 와
  ledger row 는 audit / replay 용으로 유지한다.

이는 active contract 를 대체한 것이 아니라 설계 방향이다. 구현이 의존하기 전에
contract 변경이 먼저 필요하다.

## 11. 처음 읽는 순서

새 contributor 는 다음 순서로 읽으면 된다.

1. [`../llm-team.md`](../llm-team.md) - 철학과 invariant
2. [`contracts/README.md`](contracts/README.md) - 어휘와 권위 순서
3. [`architecture/pipeline-end-to-end.md`](architecture/pipeline-end-to-end.md) - cycle 이 도는 방식
4. [`architecture/worktree-pr-lifecycle.md`](architecture/worktree-pr-lifecycle.md) - slice, worktree, PR, review 의 연결
5. [`operations/cli.md`](operations/cli.md) - 실행 방법

현재 self-hosting 안정화 맥락은 다음 문서를 함께 본다.

- [`references/agent-output-and-review-mechanics.md`](references/agent-output-and-review-mechanics.md)
- [`../.human/draft/2026-05-10-self-host-stall-and-call-amplification.md`](../.human/draft/2026-05-10-self-host-stall-and-call-amplification.md)
