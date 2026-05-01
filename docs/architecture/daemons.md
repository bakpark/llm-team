# Caller Runners and Workers

본 문서는 Caller 실행 방식의 구현 매핑이다. 동시성의 authoritative 규칙은 [`RGC-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-LEASE)와 [`RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS)가 정의한다.

## Runner Model

구현은 단일 프로세스 runner 또는 역할별 runner로 구성할 수 있다.

권장 role queue:

| Role | Operation |
|---|---|
| PO | Compose-PO |
| PM | Compose-PM |
| Planner | Decompose |
| Coder | Implement |
| Reviewer | Review |
| Integrator | Refactor |
| QA | Validate |

이 runner들은 Agent 자체가 아니라 Caller 실행 단위다. Runner는 queue를 조회하고, lease를 획득하고, Context Manifest를 만들고, Agent를 1회 호출하고, output을 검증한 뒤 operational write를 수행한다.

## Execution Loop

```text
loop:
  1. load target config
  2. check global control state RUNNING|PAUSED
  3. run stale recovery sweep
  4. list ready objects for each operation
  5. claim object with lease
  6. build Context Manifest
  7. run deterministic verification if operation requires it
  8. invoke Agent once
  9. validate output envelope and revision pins
 10. perform operational transition
 11. write transition ledger
 12. notify if needed
```

`PAUSED` 상태에서는 새 lease를 claim하지 않는다. 이미 진행 중인 lease는 정책에 따라 완료를 기다리거나 stale recovery 대상이 된다.

## Worker Slots

Worker slot은 role별로 독립된다.

| Role | 기본 slot 성격 |
|---|---|
| PO | 낮은 빈도, 보통 1 |
| PM | 낮은 빈도, 보통 1 |
| Planner | 마일스톤 직렬화 때문에 보통 1 |
| Coder | Task 병렬화 대상, N 가능 |
| Reviewer | Code CP 병렬 검토 대상, N 가능 |
| Integrator | 마일스톤당 1 |
| QA | 마일스톤당 1 |

동일 객체는 active lease 1개만 가질 수 있다. slot 수는 처리량만 조절하고 권한 경계를 바꾸지 않는다.

## Scheduling Fairness

동일 우선순위의 ready 객체는 oldest-ready-first로 claim한다. priority override가 있으면 transition ledger에 기록한다.

## Single Instance

역할별 runner를 여러 프로세스로 실행할 수 있지만, 동일 객체 claim은 lease compare-and-set으로 직렬화해야 한다. OS-level lock은 보조 수단이며 authoritative concurrency control은 lease다.

## Deployment Options

### Single Runner

```bash
./scheduler/runner.sh
```

모든 role queue를 한 프로세스가 순회한다. 운영이 단순하고 race window가 작다.

### Role Runners

```bash
./scheduler/runner.sh po
./scheduler/runner.sh pm
./scheduler/runner.sh planner
./scheduler/runner.sh coder
./scheduler/runner.sh reviewer
./scheduler/runner.sh integrator
./scheduler/runner.sh qa
```

역할별 장애 격리가 쉽다. 단, lease store의 원자성이 더 중요하다.

## Logs and Artifacts

Runner는 다음 artifact를 남겨야 한다.

- Context Manifest
- Agent output envelope
- Verification Run log
- Transition Ledger entry
- lease claim / release 기록
- notification marker

작업 로그와 임시 worktree는 `workdir/` 아래에 둘 수 있다. `workdir/`은 영속 contract store가 아니며, 필요한 기록은 persistent store에 복사해야 한다.

## Stale Recovery

Stale recovery는 runner loop마다 수행할 수 있다. recovery 대상과 전이는 [`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY)를 따른다.
