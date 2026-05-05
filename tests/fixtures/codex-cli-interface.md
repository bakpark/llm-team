# Codex CLI Interface — Verified

본 문서는 plan 의 "Codex CLI 인터페이스 검증 (구현 전 필수 작업)" 단계 결과를 기록한다.

## 검증 일시 및 환경

- date: 2026-05-06
- binary: `/usr/local/bin/codex`
- 명령: `codex exec --help`

## 결과 요약

`codex exec` 의 prompt 입력은 아래 두 방식이 공식 지원된다 (`--help` 본문 인용):

> `[PROMPT]` — Initial instructions for the agent. If not provided as an argument
> (or if `-` is used), instructions are read from stdin. If stdin is piped and a
> prompt is also provided, stdin is appended as a `<stdin>` block.

채택 방식: **stdin auto-read** (positional argv 미사용). 이유:

- 큰 prompt 도 `ARG_MAX` 한계 없음 (계약 `ARC-CALL-SEMANTICS` 의 argv 금지 조항 부합).
- `-` sentinel 도 동일 의미라 호환되지만, 인자 자체를 두지 않는 게 가장 단순.

## 사용 flag (확정)

| flag | 값 | 비고 |
|---|---|---|
| `exec` | (positional sub-command) | 비대화 1-shot |
| `--skip-git-repo-check` | — | git 리포 검증 우회 |
| `--cd <DIR>` | `agent_cwd` | 작업 디렉토리 |
| `--color <COLOR>` | `never` | 가능값: always, never, auto |
| `--model <MODEL>` | (선택) | target.yaml 의 `model` |
| `--profile <CONFIG_PROFILE>` | (선택) | `~/.codex/config.toml` 의 named profile |

## adapter 구현 상 결정

`src/adapters/llm-runner/codex-cli.ts` 의 `buildArgv()` 는 위 flag 만 emit하고 prompt는 stdin pipe로 전달. 추가 분기(positional argv, `--prompt-file`) 불필요.
