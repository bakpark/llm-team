# Onboarding Gate

`run` / `run-once` / `daemon start` 진입점은 target 의 onboarding 체크리스트 (`github-pipeline/v1` preset) 를 hard gate 로 평가한다. block severity 항목이 하나라도 FAIL 이면 exit 2 로 차단한다.

## Inspect / Ack

```bash
llm-team onboarding status <target>           # PASS/FAIL/WARN/SKIP TSV
llm-team onboarding status <target> --json    # JSON 형식
llm-team onboarding ack <target> <key> --note "..."
llm-team onboarding wizard <target>           # TTY 대화형
llm-team onboarding list-schemas
```

ack 가능한 키 목록은 `llm-team onboarding list-schemas` 출력의 6 번째 칼럼.

## 게이트 우회

세 가지 우회 수단이 있고 각각 의도가 다르다.

| 수단 | 의도 |
|---|---|
| `--dry-run` | 실제 실행 없이 흐름만 확인. 게이트 자체를 건너뜀. |
| `--allow-incomplete-onboarding` | 운영 권한자가 1 회 강제로 진행. warn 메시지 출력. |
| `LLM_TEAM_SKIP_ONBOARDING_GATE=1` | 자동화/CI 환경에서 환경변수 우회. warn 메시지 출력. |

## 기존 target migration

본 게이트 도입 이전에 만든 target.yaml 은 `onboarding:` 섹션이 없다. 게이트는 기본값 (`schema=github-pipeline/v1`, `acks={}`) 을 가정해 평가하므로, `run` / `daemon start` 가 갑자기 차단될 수 있다. 기존 target 은 다음 순서로 보강한다.

1. `llm-team onboarding status <target>` 로 현재 FAIL 항목 확인.
2. 자동 검증 가능한 항목은 환경/파일 시스템 측에서 직접 해결 (예: workdir scaffold 누락이면 `llm-team target init <target>`).
3. 정책 결정 항목은 `llm-team onboarding ack <target> <key> --note "..."` 로 ack.
4. 임시 우회가 필요한 자동화 흐름이 있다면 `LLM_TEAM_SKIP_ONBOARDING_GATE=1` 또는 `--allow-incomplete-onboarding` 사용.

## 운영 환경 요구

- **`timeout` 바이너리 (GNU coreutils)** 가 PATH 에 있어야 한다. macOS 는 기본 미포함이므로 `brew install coreutils` 후 `timeout` (또는 `gtimeout`) 이 보이는지 확인. 부재 시 `LR_TIMEOUT_SEC>0` cycle 은 어댑터가 exit 66 (`adapter_unavailable`) 으로 fail-fast.
- **`LLM_TEAM_LR_TIMEOUT_SEC`** 기본값은 600 (10 분). hang 방지용. 디버깅 시 `0` 으로 비활성화 가능.
- **Cycle bundle (RW 4 역할 진단 자료)** 은 `workdir/<target>/cycles/<Role>-<obj_id>-<hash12>/` 에 영속된다 — `prompt.txt`, `envelope.json`, `lr_meta.json`, `summary.json`, `diff/{pre.head,pre.dirty.diff,after-lr.dirty.diff,applied.diff,post.head,post.dirty.diff}`, 실패 시 `diagnostics.txt` + `attempts/<idx>/`. 디렉토리 권한 0700, 파일 권한 0600. `LLM_TEAM_CYCLE_BUNDLE_DISABLED=1` 로 비활성화 가능. `workdir/` 는 이미 `.gitignore`.

## See Also

- [`docs/contracts/target-config-contract.md`](../contracts/target-config-contract.md) — `TCC-ONBOARDING` 정의 (스키마, severity, ack 의미).
- [`docs/operations/cli.md`](cli.md) — 일반 CLI 사용법.
