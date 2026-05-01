#!/usr/bin/env bash
# scheduler/daemon.sh — single-instance long-running daemon for one agent.
#
# Usage:
#   scheduler/daemon.sh <agent> [interval_seconds]
#
# Where <agent> ∈ { po, pm, dev, qa }.
#
# Behaviour:
#   1. Acquire single-instance lock via atomic `mkdir` on
#      workdir/daemon-<agent>.lockd + PID validation.
#      - mkdir이 atomic이라 race 안전.
#      - 기존 lockdir이 있으면 PID file을 읽어 kill -0으로 살아있는지 확인.
#      - 죽은 PID(stale)면 정리 후 재시도. 살아있는 PID면 즉시 exit 1.
#      - flock보다 portable (macOS는 flock 기본 미설치).
#      - GitHub 라벨 atomic 전이만 동시성 제어 (외부 lock 추가 없음 — 사용자 요구).
#   2. SIGTERM/SIGINT 수신 시 graceful shutdown 플래그 set.
#   3. 무한 루프:
#      a. list_active_targets로 enabled 타겟 목록 수집
#      b. 각 타겟에 대해 scheduler/run-<agent>.sh <target> 호출
#      c. interval만큼 sleep (1초 단위 SIGTERM 체크 — 즉시 종료 가능)
#   4. 각 tick의 stale recovery는 run-<agent>.sh 진입 직후 inline 실행됨 (기존 동작).
#
# Default intervals (cron 모델의 주기와 동일):
#   po=600s (10분) / pm=300s (5분) / dev=120s (2분) / qa=120s (2분)
#
# Override:
#   - 두 번째 인자로 정수(초) 전달
#   - 또는 환경변수 LLM_TEAM_DAEMON_INTERVAL=<seconds>
#
# Recommended deployment:
#   - macOS: launchd plist (KeepAlive=true + ThrottleInterval=10)
#   - Linux: systemd unit (Restart=always)
#   본 스크립트는 자체 재시작 루프를 두지 않는다 — supervisor가 재시작 책임.
#
# Single-target test mode:
#   환경변수 LLM_TEAM_DAEMON_ONCE=1 + LLM_TEAM_DAEMON_TARGET=<name>를 set하면
#   1회 tick만 실행하고 종료한다 (smoke test용).

set -euo pipefail

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <agent> [interval_seconds]

agent must be one of: po | pm | dev | qa
EOF
  exit 64
}

AGENT="${1:-}"
case "${AGENT}" in
  po)  DEFAULT_INTERVAL=600 ;;
  pm)  DEFAULT_INTERVAL=300 ;;
  dev) DEFAULT_INTERVAL=120 ;;
  qa)  DEFAULT_INTERVAL=120 ;;
  *)   usage ;;
esac

INTERVAL="${2:-${LLM_TEAM_DAEMON_INTERVAL:-${DEFAULT_INTERVAL}}}"
case "${INTERVAL}" in
  ''|*[!0-9]*) echo "interval must be a positive integer (got '${INTERVAL}')" >&2; exit 64 ;;
esac
[ "${INTERVAL}" -ge 1 ] || { echo "interval must be >= 1 second" >&2; exit 64; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export LLM_TEAM_ROOT

# shellcheck source=../lib/common.sh
. "${LLM_TEAM_ROOT}/lib/common.sh"

# ---------------------------------------------------------------------------
# Single-instance lock — atomic mkdir + PID validation (portable; no flock dep)
# ---------------------------------------------------------------------------
LOCK_PARENT="${LLM_TEAM_ROOT}/workdir"
LOCKDIR="${LOCK_PARENT}/daemon-${AGENT}.lockd"
PIDFILE="${LOCKDIR}/pid"
mkdir -p "${LOCK_PARENT}"

_acquire_lock() {
  # First attempt
  if mkdir "${LOCKDIR}" 2>/dev/null; then
    return 0
  fi
  # Lockdir exists — check if owner is alive
  local existing
  existing="$(cat "${PIDFILE}" 2>/dev/null || echo "")"
  if [ -n "${existing}" ] && kill -0 "${existing}" 2>/dev/null; then
    log_error "daemon ${AGENT}: another instance is already running (pid=${existing}, lockdir=${LOCKDIR})"
    return 1
  fi
  # Stale lockdir — remove and retry once
  log_warn "daemon ${AGENT}: removing stale lockdir (orphaned pid='${existing:-unknown}')"
  rm -rf "${LOCKDIR}" 2>/dev/null || true
  if mkdir "${LOCKDIR}" 2>/dev/null; then
    return 0
  fi
  log_error "daemon ${AGENT}: failed to acquire lockdir after stale cleanup"
  return 1
}

if ! _acquire_lock; then
  exit 1
fi

# Write our pid for the next instance's stale check.
printf '%s\n' "$$" >"${PIDFILE}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------
SHUTDOWN=0
_on_shutdown() {
  SHUTDOWN=1
  log_info "daemon ${AGENT}: shutdown signal received; finishing current cycle then exiting"
}
trap _on_shutdown SIGTERM SIGINT
trap 'rm -rf "${LOCKDIR}" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# Once mode (test)
# ---------------------------------------------------------------------------
if [ "${LLM_TEAM_DAEMON_ONCE:-0}" = "1" ]; then
  ONCE_TARGET="${LLM_TEAM_DAEMON_TARGET:-}"
  if [ -z "${ONCE_TARGET}" ]; then
    log_error "daemon ${AGENT}: LLM_TEAM_DAEMON_ONCE=1 set but LLM_TEAM_DAEMON_TARGET is empty"
    exit 64
  fi
  log_info "daemon ${AGENT}: ONCE mode for target=${ONCE_TARGET}"
  "${SCRIPT_DIR}/run-${AGENT}.sh" "${ONCE_TARGET}" || \
    log_warn "daemon ${AGENT}: run-${AGENT}.sh ${ONCE_TARGET} returned non-zero"
  log_info "daemon ${AGENT}: ONCE mode done"
  exit 0
fi

# ---------------------------------------------------------------------------
# Long-running loop
# ---------------------------------------------------------------------------
log_info "daemon ${AGENT}: started pid=$$ interval=${INTERVAL}s lockdir=${LOCKDIR}"

while [ "${SHUTDOWN}" -eq 0 ]; do
  # Iterate enabled targets
  TARGETS="$(list_active_targets 2>/dev/null || true)"
  if [ -z "${TARGETS}" ]; then
    log_info "daemon ${AGENT}: no enabled targets; sleeping"
  else
    while IFS= read -r target; do
      [ -n "${target}" ] || continue
      [ "${SHUTDOWN}" -eq 0 ] || break
      log_info "daemon ${AGENT}: tick target=${target}"
      "${SCRIPT_DIR}/run-${AGENT}.sh" "${target}" || \
        log_warn "daemon ${AGENT}: run-${AGENT}.sh ${target} returned non-zero"
    done <<EOF
${TARGETS}
EOF
  fi

  # Sleep with 1s granularity so SIGTERM is responsive.
  i=0
  while [ "${i}" -lt "${INTERVAL}" ] && [ "${SHUTDOWN}" -eq 0 ]; do
    sleep 1
    i=$((i + 1))
  done
done

log_info "daemon ${AGENT}: shutdown complete"
exit 0
