# Caller Runners and Workers

본 문서는 Caller 실행 방식의 구현 매핑이다. 동시성의 authoritative 규칙은 [`RGC-LEASE-KINDS`](../contracts/reliability-and-gate-contract.md#RGC-LEASE-KINDS), [`RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS), [`RGC-CROSS-SLOT-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-CROSS-SLOT-FAIRNESS) 가 정의한다.

## Runner Model

구현은 다음 차원의 worker / coordinator 를 가진다.

1. **Turn worker** — AgentProfile 별 daemon. dialogue_coordinator 가 enqueue 한 ready turn 을 pickup 하여 LLM 호출 → SessionTurn 영속화까지 수행.
2. **Dialogue coordinator** — `application/dialogue_coordinator.sh` 를 호출하는 daemon. DialogueSession 의 turn coordination, finalization 평가, session_outcome 응축, dispatch 를 담당.
3. **Dual-track scheduler** — `application/dual_track_scheduler.sh` 를 호출하는 daemon. milestone 의 dual-slot promotion (intake_queue / delivery_promotion_queue) 을 담당. slot_lock 의 short transaction 만 보유.

권장 turn worker (AgentProfile 별):

| AgentProfile | 호출 가능한 (parent_loop, phase|purpose) |
|---|---|
| `atlas` | outer Discovery lead, outer Specification lead, outer Planning lead, middle review reviewer (architectural) |
| `forge` | inner tdd_build lead (slice-local), middle review reviewer (rework 가능성), outer Specification reviewer, outer Planning reviewer |
| `sentinel` | middle review lead, outer Validation lead, outer Discovery reviewer, outer Specification reviewer, outer Planning reviewer |
| `scout` | outer Validation evidence (observer), RefactorBacklog 정기 scan |
| `human` | (외부 신호 변환만, daemon 점유 없음) |

dialogue_coordinator daemon 은 `loop_policies.<loop>.<phase|purpose>` 를 읽어 finalization 평가를 수행한다.

dual_track_scheduler daemon 은 `target.dual_track` 정책과 promotion guard 를 읽어 slot 진입을 결정한다.

## Execution Loop

### Turn worker loop

```text
loop:
  1. load target config
  2. check global control state RUNNING|PAUSED
  3. run stale recovery sweep (turn_lease 만료 / session_lease cross-validation)
  4. pickup ready turn for this profile (oldest-ready-first)
  5. claim turn_index CAS (or turn_lease)
  6. build Context Manifest + assemble session_context_ref
  7. invoke Agent runner once (ARC port)
  8. validate output envelope and revision pins
  9. persist SessionTurn (envelope + workspace_commit if inner)
 10. write transition ledger
 11. notify if needed
```

### Dialogue coordinator loop

```text
loop:
  1. recovery sweep (session-stale / coordinator-failure / session-timeout)
  2. pickup ready session (states: SESSION_OPEN, AWAITING_REVALIDATION recently re-validated)
  3. claim session_lease
  4. evaluate finalization rule × required_evidence × composite_rule
  5. branch:
     - converged → emit session_outcome contribution + dispatch (caller_dispatch)
     - not yet converged → routing decision for next turn (accepted/overridden/dropped) → enqueue next turn for worker
     - timeout/abandoned → dispatch escalation
  6. write transition ledger (action_kind=session_finalize 또는 session_progress)
  7. release session_lease
```

### Dual-track scheduler loop

```text
loop:
  1. recovery sweep (slot_lock stale)
  2. inspect intake_queue head + delivery_promotion_queue head
  3. for each candidate:
     - check slot 빔 + promotion guard
     - claim slot_lock (short transaction)
     - atomic promotion 4 단계 (state validate → persist → ledger → release)
  4. emit telemetry (cross-slot fairness 관측)
```

`PAUSED` 상태에서는 어떤 lease (slot_lock / slice_lease / session_lease / turn_lease) 도 새로 claim 하지 않는다. 진행 중인 lease 는 정책에 따라 완료를 기다리거나 stale recovery 대상이 된다.

## Worker Slots

Worker slot 은 AgentProfile 별로 독립된다. dialogue_coordinator 와 dual_track_scheduler slot 은 별도 차원이다.

| Slot 종류 | 기본 slot 성격 |
|---|---|
| `atlas` worker | milestone 당 1-2. outer Discovery / Specification / Planning lead, middle review architectural reviewer |
| `forge` worker | slice 병렬화 대상, N 가능. inner tdd_build lead (slice-local), middle review reviewer |
| `sentinel` worker | milestone 당 1-2. middle review lead, outer Validation lead, 다른 outer phase reviewer |
| `scout` worker | 0-1 (필요 시). outer Validation evidence, RefactorBacklog 정기 scan |
| Dialogue coordinator | 1. session 단위로 finalization 평가를 직렬화 |
| Dual-track scheduler | 1. slot promotion 을 직렬화 |

동일 객체에는 active lease 1개만. slot 수는 처리량만 조절하고 권한 경계를 바꾸지 않는다.

## Scheduling Fairness

| 차원 | 정책 |
|---|---|
| Within-queue (intake / promotion / turn pickup) | oldest-ready-first ([`#RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS)) |
| Cross-slot (Discovery N+1 ↔ Delivery N) | `target.dual_track.priority` ∈ {delivery_first (default), balanced, discovery_first} ([`#RGC-CROSS-SLOT-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-CROSS-SLOT-FAIRNESS)) |
| WIP limit | `loop_policies.<phase>.concurrent_sessions` (default = **1**, fail-serial — [`#RGC-FAIRNESS`](../contracts/reliability-and-gate-contract.md#RGC-FAIRNESS) Concurrent Sessions Hard Default 절) |
| Turn ordering (within DialogueSession) | [`#AGC-TURN-ORDERING`](../contracts/agent-and-context-contract.md#AGC-TURN-ORDERING) 의 우선순위 (1: accepted next_action_request, 2: profile capability auto-routing, 3: LRU fallback) + `max_consecutive_per_profile` fairness cap |

priority override 와 turn_ordering 위반 (`caller_routing_decision.decision = delayed/overridden`) 은 transition ledger 에 기록한다.

### slice_lease 가 다중 session 을 보호하는 절차

dialogue_coordinator 가 동일 slice 의 inner 와 middle 을 동시에 SESSION_OPEN 으로 운영하는 것은 [`#SOC-SESSION-LIFECYCLE`](../contracts/state-and-operation-contract.md#SOC-SESSION-LIFECYCLE) Dispatch 책임 절에 의해 금지된다. slice_lease 가 슬라이스 단위로 보호하며, dialogue_coordinator 는 다음 순서로 invariant 를 유지한다:

1. 새 session 을 SESSION_OPEN 으로 영속화하기 전에 slice_lease claim.
2. inner CONVERGED 직후 SLICE_BUILDING → SLICE_REVIEWING 전이의 동기 dispatch 가 inner session 의 lease 해제와 middle session 의 lease claim 을 연속으로 처리.
3. concurrent_sessions override 가 있어도 동일 slice 에 대해서는 1 session 만 허용 (override 는 서로 다른 slice 또는 milestone 사이의 병렬도만 늘린다).

## Single Instance

AgentProfile 별 worker, dialogue_coordinator, dual_track_scheduler 를 여러 프로세스로 실행할 수 있지만, 동일 객체 claim 은 lease compare-and-set 으로 직렬화해야 한다. OS-level lock 은 보조 수단이며 authoritative concurrency control 은 4-lease kind 다.

## Deployment Options

### Single Runner

```bash
./scheduler/runner.sh
```

모든 turn queue, dialogue_coordinator, dual_track_scheduler 를 한 프로세스가 순회한다. 운영이 단순하고 race window 가 작다.

### Profile + Coordinator + Scheduler Daemons

```bash
./scheduler/runner.sh --agent-profile atlas
./scheduler/runner.sh --agent-profile forge
./scheduler/runner.sh --agent-profile sentinel
./scheduler/runner.sh --agent-profile scout
./scheduler/runner.sh --dialogue-coordinator
./scheduler/runner.sh --dual-track-scheduler
```

AgentProfile 별 장애 격리가 쉽다. dialogue_coordinator 와 dual_track_scheduler 가 별도 daemon 이므로 finalization 평가와 slot promotion 이 worker 호출 시간에 영향받지 않는다. 단, lease store 의 원자성이 더 중요하다 (특히 4 lease kind 의 acquisition order CI).

## Logs and Artifacts

Runner 는 다음 artifact 를 남겨야 한다.

- Context Manifest (turn 단위)
- Agent output envelope (SessionTurn)
- prior_turn_log_snapshot (KAC-TURN-LOG-COMPACTION)
- Verification Run / Metric Run log
- Transition Ledger entry
- 4 lease kind 의 claim / release 기록
- notification marker

작업 로그와 임시 worktree 는 `workdir/` 아래에 둘 수 있다.

## Stale Recovery

Stale recovery 는 매 cycle 마다 수행한다. recovery 대상과 전이는 [`RGC-RECOVERY`](../contracts/reliability-and-gate-contract.md#RGC-RECOVERY) 와 [`SOC-RECOVERY-OPERATION`](../contracts/state-and-operation-contract.md#SOC-RECOVERY-OPERATION) 을 따른다. 4 lease kind 별로 sweeper 가 동작한다.

## Daemon Lifecycle

[`RGC-DAEMON-STARTUP`](../contracts/reliability-and-gate-contract.md#RGC-DAEMON-STARTUP) 의 atomic 시작 invariant 는 두 계층이 분담한다.

### Per-process (`scheduler/daemon.sh`)

- **PID lockdir**: turn worker 는 `workdir/<target>/daemon/agent/<profile>.lock/`, dialogue_coordinator 는 `workdir/<target>/daemon/dialogue_coordinator.lock/`, dual_track_scheduler 는 `workdir/<target>/daemon/dual_track_scheduler.lock/` 디렉토리. `mkdir` 의 atomic 성질로 중복 기동 차단.
- **stale-pid 회수**: 기동 시 lockdir 의 기록된 pid 가 살아있지 않으면 자동 회수.
- **종료 신호**: SIGTERM 수신 시 *현재 cycle 종료 후* loop 를 빠져나간다. 진행 중인 lease 는 정상 release 된다.

### Atomic multi-daemon startup (`scripts/cli/daemon.sh`)

- **부분 기동 차단**: 모든 lockdir 가 점유 가능한지 *사전 점검* 한 뒤 fork. 한 daemon 이라도 점유에 실패하면 sibling 종료 + 전체 실패 종결.
- **acquisition order CI**: lib/lease.sh 의 acquisition order 가 CI 에서 violation 0건임을 startup 진입 게이트로 검증 (Stage 2 DoD).
- **System-scoped ledger**: atomic 기동·실패 흔적은 system scope ledger 에 기록.

### 운영 의의

부분적으로만 기동된 군집은 fairness 가정과 dialogue_coordinator 부재로 인한 finalization 정체를 일으킨다. 모든 기동은 "전체 성공" 또는 "전체 미시작" 두 상태만 허용한다.
