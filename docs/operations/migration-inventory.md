# Migration Inventory

phase-prod-0 시점의 `docs/migration/*.md` enumeration. production target 진입 전 적용 여부를 항목별 기록한다.

| 파일 | status | 근거 |
|---|---|---|
| `docs/migration/phase-8c-vr-coverage-backfill.md` | `not_applicable` (greenfield) / `deferred` (live target) | 신규 production target 은 phase 8c 이후 코드로 처음 부팅되므로 pre-8c VR 자체가 없다 → not_applicable. 기존 운영 target 이 있다면 본 문서의 deploy procedure 를 따라 backfill 후 phase 8c 적용. phase-prod-0 의 e2e-sandbox 는 신규 fixture 이므로 not_applicable. |

## production 진입 전 적용 필요

(없음 — phase-prod-0 시점 기준)

## production 진입과 무관 (deferred 가능)

- `phase-8c-vr-coverage-backfill.md` — 기존 live target 에만 영향. phase-prod-* 는 신규 sandbox / production target 만 다루므로 본 cycle 에서는 적용 의무 없음.

## Update policy

- 신규 `docs/migration/*.md` 추가 시 본 표에 동시 등록.
- production target 진입 전 모든 `applied` 또는 `not_applicable` 상태여야 한다 (`deferred` 는 운영 결정 사유 기록 후 허용).
