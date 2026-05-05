#!/usr/bin/env bash
# lib/backoff.sh - generic exponential backoff sleep helper.
#
# 외부 의존성 없음. RANDOM 만 사용 (jitter). LLM runner / GH retry / 기타
# transient-error retry 호출자가 공유.

# backoff_sleep <attempt> <base_seconds> <max_seconds>
#
# attempt 는 0부터 시작 (0 이면 즉시 base_seconds 의 jitter, 1 이면 2*base, ...).
# 실제 sleep 초 = min(base * 2^attempt, max) * (1 + jitter), jitter ∈ [0, 0.3).
# stdout 에는 출력 없음. sleep 이 정수 초 단위인 환경 (POSIX) 호환을 위해 ceil.
backoff_sleep() {
  local attempt="${1:-0}" base="${2:-1}" max="${3:-60}"
  if ! [[ "${attempt}" =~ ^[0-9]+$ ]] || ! [[ "${base}" =~ ^[0-9]+$ ]] || ! [[ "${max}" =~ ^[0-9]+$ ]]; then
    log_error "backoff_sleep: attempt/base/max must be non-negative integers"
    return 2
  fi
  local exp delay jitter_pct delay_with_jitter
  exp=$(( 1 << attempt ))
  delay=$(( base * exp ))
  if [ "${delay}" -gt "${max}" ]; then
    delay="${max}"
  fi
  # jitter: 0..299 (= 0% .. 29.9%), 정수 산술로만 처리 (floor).
  jitter_pct=$(( RANDOM % 300 ))
  delay_with_jitter=$(( delay + (delay * jitter_pct) / 1000 ))
  if [ "${delay_with_jitter}" -lt 1 ]; then
    delay_with_jitter=1
  fi
  sleep "${delay_with_jitter}"
}
