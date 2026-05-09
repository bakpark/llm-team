# Production Migration Checklist

`docs/operations/migration-inventory.md` 의 항목별 *적용 결과* 표. production target 진입 전 모든 항목이 `applied` / `not_applicable` 또는 `deferred (운영 결정 사유 + blocker=advisory/pass)` 여야 한다.

## 적용 결과

| 항목 ID | status | 적용 일자 | 검증 명령 / Evidence | Production 차단 |
|---|---|---|---|---|
| `phase-8c-vr-coverage-backfill` | `not_applicable` (greenfield) / `deferred` (live target) | YYYY-MM-DD | greenfield: 새 target 은 phase-8c 이후 코드로 첫 부팅 → 기존 VR 없음. live target: `docs/migration/phase-8c-vr-coverage-backfill.md` 의 deploy procedure 적용 후 확인. | **advisory** (greenfield) / **blocker** (기존 운영 target 보유 시) |

신규 production target 은 `not_applicable` 로 진입 가능 (`migration-inventory.md` §production 진입 전 적용 필요 = "(없음)"). 기존 live target 을 phase-8c 이후 코드로 마이그레이션하는 경우만 `blocker`.

## Production 차단 분류

- **blocker** — 본 항목 PASS 전까지 production target 전환 금지.
- **advisory** — production 전환 가능. 단, 운영 첫 N cycle 동안 모니터링 필요.
- **pass** — 본 항목과 무관 (`not_applicable`).

## Update Policy

- 신규 `docs/migration/*.md` 추가 시 `migration-inventory.md` 에 등록 후 본 표에도 동시 등록.
- 항목 ID 는 `migration-inventory.md` 와 1:1 정합 (파일명 stem).
- `deferred` 는 운영 결정 사유 + blocker 분류 명시 후에만 사용.

## See Also

- [`docs/operations/migration-inventory.md`](migration-inventory.md) — phase-prod-0 시점의 enumeration.
- [`docs/operations/e2e-go-no-go.md`](e2e-go-no-go.md) — go/no-go 결정에서 본 표를 참조.
- [`docs/operations/production-target.md`](production-target.md) — `validateOrThrow` + `migration-inventory` 정합성을 production 진입 조건으로 명시.
