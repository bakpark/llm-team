# Production Target Configuration Guide

production target.json 작성 가이드. 본 문서는 `src/config/target-schema.ts` 의 Zod 스키마와 `src/application/config-validator.ts` 의 `validateOrThrow` 가 single source of truth 이다 — 본 문서는 운영 권장값과 sandbox 와의 차이만 기술한다.

## 필수 필드

| 경로 | 권장값 / 제약 |
|---|---|
| `identity.target_id` | 운영 식별자 (kebab-case) |
| `identity.kind` | `external` (LLM-team 자체 운영 시 `self-hosting` — agent_cwd ≠ workdir_path 강제) |
| `identity.workdir_path` | 영속 store 절대경로 |
| `identity.agent_cwd` | worktree root. `self-hosting` 시 workdir_path 외부 |
| `identity.audit_hash_seed` | 1회 발급 후 변경 금지 |
| `agent_profiles.{atlas,forge,sentinel,scout}.runner` | `claude_code` 또는 `codex_cli` |
| `governance.human_team` | 운영 팀 식별자 |
| `governance.control_issue_number` / `contract_change_issue_number` | 서로 다름 |
| `governance.human_team_provider` | `fs-mirror` (기본) 또는 `github` |
| `lease.ttl_default_ms` | 60000 ~ 300000 권장. 무한/0 금지 |
| `dual_track.priority` | `delivery_first` (기본) / `balanced` / `discovery_first` |
| `context_budget` | (parent_loop, phase_or_purpose) 별 token_hard_cap. omit 시 architecture default 적용 (`CONTEXT_BUDGET_DEFAULTS`) |

## 금지 사항

- `agent_profiles.*.runner = "fake"` — production 차단 (PR #73 P1; `runner-registry.ts:80-86` 가 `allowFake: false` 로 throw).
- `lease.ttl_*_ms` 의 0 또는 음수 — Zod `.positive()` 거부.
- `governance.control_issue_number === contract_change_issue_number` — schema refine 거부.

## GitHub side-effect 격리 권장

- 신규 운영 타겟은 `governance.human_team_provider: "fs-mirror"` 로 시작 — 외부 GitHub Teams 호출 0건.
- 검증 충분 후 `github` 으로 전환. 전환 시점에 `GH_TOKEN` 권한 / rate-limit 확인 (pre-e2e-checklist §M-2-6, §M-3-3).
- 운영 부작용을 sandbox repo / fork 에 한정하고 싶을 때는 `identity.label_prefix` 로 production label 과 분리.

## sandbox vs production 차이

| 항목 | e2e-sandbox (`tests/fixtures/targets/e2e-sandbox.json`) | production |
|---|---|---|
| `target_id` | `e2e-sandbox` | 운영 식별자 (예: `acme-prod`) |
| `workdir_path` | `/tmp/llm-team-e2e/sandbox/...` (매 run 격리, mkdtempSync 권장) | 영속 디스크 (운영 user 0700) |
| `human_team_provider` | `fs-mirror` 강제 | `fs-mirror` → `github` 단계 전환 |
| `label_prefix` | `e2e:` (production label 과 격리) | 운영 prefix 또는 미설정 |
| `lease.ttl_*` | 짧게 (J-6: stale 회수 빠름) | 운영 부하에 맞춰 조정 |
| `runner: "fake"` | 금지 | 금지 |

## 검증 절차

1. `validateOrThrow(JSON.parse(...))` 가 throw 없이 반환.
2. `npm run typecheck` 통과.
3. healthcheck Stage 1~2 PASS.
4. live smoke 가 필요하면 비용 cap 설정 후 Stage 3 를 opt-in 으로 실행.
