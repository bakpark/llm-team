# Caller Runners and Workers

본 문서는 Caller 실행 방식의 구현 매핑이다. 동시성의 authoritative 규칙은 [`RGC-PHASE-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE) 와 [`RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS) 가 정의한다.

## Runner Model

구현은 두 차원의 worker 를 가진다.

1. **Contribution worker** — AgentProfile 별 daemon. `(phase, contribution_kind)` 조합의 ready unit 을 pickup 하여 Agent 호출 → contribution submit 까지 수행.
2. **Phase coordinator** — `application/phase_coordinator.sh` 를 호출하는 daemon. PhaseRun 별로 quorum 평가와 final artifact 압축을 수행.

권장 contribution worker (AgentProfile 별):

| AgentProfile | 호출 가능한 phase × contribution_kind |
|---|---|
| `atlas` | Discovery lead, Specification lead, Planning lead, CodeReview review_verdict, Integration review_verdict, Validation summary |
| `forge` | Specification review_verdict, Planning review_verdict, Implementation lead/rework, CodeReview rework_patch trigger |
| `sentinel` | Discovery review_verdict, Specification review_verdict, Planning review_verdict, CodeReview lead, Integration lead, Validation lead |
| `scout` | Integration evidence, Validation evidence |
| `human` | (외부 신호 변환만, daemon 점유 없음) |

phase coordinator daemon 은 phase 별 `phase_policies.<phase>` 를 읽어 quorum 평가를 수행한다.

이 runner 들은 Agent 자체가 아니라 Caller 실행 단위다. Contribution worker 는 ready contribution unit 을 pickup, lease 획득, Context Manifest 생성, Agent 1회 호출, envelope 검증 후 contribution 을 `CONTRIB_SUBMITTED` 로 영속화한다. Phase coordinator 는 `CONTRIB_SUBMITTED` 들을 모아 quorum 평가 후 final artifact 를 dispatch 한다.

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

Worker slot 은 AgentProfile 별로 독립된다 (`atlas` slot 과 `forge` slot 이 서로 영향을 주지 않음). Phase coordinator slot 은 별도 차원이다.

| Slot 종류 | 기본 slot 성격 |
|---|---|
| `atlas` worker | 마일스톤당 1-2. Discovery / Specification / Planning lead 와 CodeReview / Validation 의 architecture review |
| `forge` worker | Task 병렬화 대상, N 가능. Implementation lead/rework, Specification / Planning review_verdict |
| `sentinel` worker | 마일스톤당 1-2. CodeReview / Integration / Validation lead, Discovery / Specification / Planning approval review |
| `scout` worker | 0-1 (필요 시). Integration / Validation 의 evidence contribution |
| Phase coordinator | phase 별 1. PhaseRun id 단위로 quorum 평가를 직렬화 |

동일 객체 (contribution 또는 PhaseRun) 는 active lease 1개만 가질 수 있다. slot 수는 처리량만 조절하고 권한 경계를 바꾸지 않는다. `human` AgentProfile 은 외부 신호 입력만 받으므로 worker slot 을 점유하지 않는다.

## Scheduling Fairness

동일 우선순위의 ready 객체는 oldest-ready-first로 claim한다. priority override가 있으면 transition ledger에 기록한다.

현재 구현은 후보 풀 내부의 oldest-ready-first 만 보장한다. 후보 풀이 여러 개인 role(예: PO 의 `feature-request` issue 와 `PO_DRAFT` milestone)은 tier 순회 정책을 따르며, 별도 starvation guard 나 자동 promotion sweep 은 없다. 장기 적체는 ledger/queue 관측 후 운영자가 priority override 또는 라벨 정리로 해소한다.

## Single Instance

AgentProfile 별 worker 와 phase coordinator 를 여러 프로세스로 실행할 수 있지만, 동일 객체 claim 은 lease compare-and-set 으로 직렬화해야 한다. OS-level lock 은 보조 수단이며 authoritative concurrency control 은 lease 다.

## Deployment Options

### Single Runner

```bash
./scheduler/runner.sh
```

모든 contribution queue 와 phase coordinator 를 한 프로세스가 순회한다. 운영이 단순하고 race window 가 작다.

### Profile + Coordinator Daemons

```bash
./scheduler/runner.sh --agent-profile atlas
./scheduler/runner.sh --agent-profile forge
./scheduler/runner.sh --agent-profile sentinel
./scheduler/runner.sh --agent-profile scout
./scheduler/runner.sh --phase-coordinator
```

AgentProfile 별 장애 격리가 쉽다. phase coordinator 가 별도 daemon 이므로 quorum 평가가 worker 호출 시간에 영향받지 않는다. 단, lease store 의 원자성이 더 중요하다.

`--phase-coordinator` daemon 은 `application/phase_coordinator.sh` 를 진입점으로 사용하며 `phase_policies` 와 ready PhaseRun 을 polling 한다.

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

## Daemon Lifecycle

[`RGC-DAEMON-STARTUP`](../contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) 의 atomic 시작 invariant 는 두 계층이 분담한다. 단일 프로세스의 lock 점유·신호 처리는 `scheduler/daemon.sh` 가, 다중 AgentProfile worker + phase coordinator 의 atomic 기동·sibling 회수·system-scoped ledger 는 `scripts/cli/daemon.sh` 가 담당한다.

### Per-process (`scheduler/daemon.sh`)

- **PID lockdir**: contribution worker 는 `workdir/<target>/daemon/agent/<profile>.lock/`, phase coordinator 는 `workdir/<target>/daemon/phase_coordinator.lock/` 디렉토리 형식. `mkdir` 의 atomic 성질로 동일 daemon 의 중복 기동을 차단한다. 점유는 `_acquire_daemon_lock` 이 수행한다.
- **stale-pid 회수**: 기동 시 lockdir 의 기록된 pid 가 살아있지 않은 경우(`kill -0` 실패) 자동 회수한다. 회수는 stale 한 pid 를 제거하고 새 lockdir 를 만든 뒤 진행한다.
- **종료 신호**: SIGTERM 수신 시 `SHUTDOWN` 플래그를 셋팅하고 *현재 cycle 종료 후* loop 를 빠져나간다. 진행 중인 lease 는 정상 release 된다. 강제 종료(SIGKILL) 의 잔여물은 [`#RGC-PHASE-LEASE`](../contracts/reliability-and-gate-contract.md#RGC-PHASE-LEASE) 의 TTL 만료에 의존한다.

### Atomic multi-daemon startup (`scripts/cli/daemon.sh`)

- **부분 기동 차단**: 다중 AgentProfile worker 와 phase coordinator 를 함께 기동할 때 모든 lockdir 가 점유 가능한지 *사전 점검* 한 뒤에만 fork 한다. `daemon_start_preflight` 가 사전 점검을, `daemon_start_atomic` 이 fork·sibling 회수·결과 집계를 담당한다. 한 daemon 이라도 점유에 실패하면 이미 기동된 sibling 을 종료시키고 전체 기동을 실패로 종결한다.
- **System-scoped ledger**: atomic 기동·실패의 흔적은 `_daemon_atomic_ledger` 가 system scope ledger 에 기록한다.

