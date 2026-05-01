# LLM Agent Team 협업 모델
## 목표
- LLM Agent 개발 자동화 파이프라인 구성
- 자동화 파이프라인은 Github의 기능을 활용하여 협업의 가시성을 높인다.

## Agent 역할 분배
- PO Agent 역할: 리서치 및 작업 분해 (작업 -> milestone)
- PM Agent 역할: 마일스톤을 통한 엔드 유저 시나리오 작성 (milestone -> user scenario)
- DEV Agent 역할: 코드 개발 (user scenario -> code branch)
- QA Agent 역할: 개발 검증 및 배포 (code branch -> merge)

## 사용 도구 정의
- 클로드 코드: 로컬 머신의 반복 스케쥴링을 통해 1-shot 프롬프팅 형태로 수행.
- cli 도구: gh, git 등
- interview 도구: Human interview 도구. 상세스펙 미정> slack or discord를 통한 인터렉션, interupt 정의 및 구현 방안 고안 필요.
- 검증 도구: 로컬 머신 인터페이스 제어 상세스펙 미정.

## Agent 사용 도구
- PO Agent 도구 : 클로드 코드, gh cli(Github 마일스톤), interview 도구
- PM Agent 도구 : 클로드 코드, gh cli(Github 마일스톤), interview 도구
- DEV Agent 도구 : 클로드 코드, git cli, gh cli(PR 작성)
- QA Agent 역할: 클로드 코드, 검증 도구