# References

본 디렉토리는 **참고용 (advisory)** 문서를 모은다. 권위 문서가 아니다.

권위 순서: [`llm-team.md`](../../llm-team.md) > [`docs/contracts/`](../contracts/) > [`docs/architecture/`](../architecture/) > 본 디렉토리.

본 디렉토리의 문서는:
- 특정 시점 코드 스냅샷에 기반한 종단 설명
- 자주 묻는 구조적 질문에 대한 안내
- contract / architecture 문서를 가로지르는 요약

이므로 **신규 코드·문서가 본 디렉토리에 의존하지 말 것** — 충돌 시 contract / architecture 가 우선이며, 본문에 명시된 SHA / 통계 / 모듈 경로는 작성 시점 기준이고 코드 변경에 따라 stale 가능하다.

## 문서

- [`implementation-overview.md`](implementation-overview.md) — 4-layer / 9-invariant / 3-loop / 7-daemon / 10 adapter 등 종단 스냅샷.
- [`agent-output-and-review-mechanics.md`](agent-output-and-review-mechanics.md) — agent 산출물(envelope) 형태, 리뷰어 approve / comment 의 실제 구현, 그리고 phase / 작업 단위별로 (1) envelope 교환 시점 (2) lead/reviewer 산출 포맷 + 영속 위치 (3) GitHub 등 외부 사이드이펙트 + 예시.
