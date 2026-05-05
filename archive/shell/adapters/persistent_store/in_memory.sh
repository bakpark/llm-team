#!/usr/bin/env bash
# adapters/persistent_store/in_memory.sh
#
# In-memory test adapter for the persistent_store port.
# 결정적 테스트의 영속 영역(ledger / artifact / lock / lease) 격리에 사용된다.
#
# 동작은 filesystem.sh 와 동일 — atomic write (tempfile + mv), atomic mkdir
# lock, ls -1tr 정렬 — 다만 루트 디렉토리만 ${LLM_TEAM_INMEM_PS_DIR} 로 swap
# 한다. 환경변수 미설정이면 adapter source 시점에 mktemp -d 후 export 한다
# (lazy init 은 path-resolver 가 command substitution 안에서 호출되어 export
# 가 부모 셸에 전파되지 않는 문제 때문에 회피).
#
# 디렉토리 규약 (filesystem.sh 와 동일 레이아웃 → 헬퍼 재사용 가능):
#   객체    : <LLM_TEAM_INMEM_PS_DIR>/<namespace>/<id>.json
#   로그    : <LLM_TEAM_INMEM_PS_DIR>/<namespace>.jsonl
#   락      : <LLM_TEAM_INMEM_PS_DIR>/<namespace>/<id>.lockd
#
# 구현 전략: filesystem adapter 를 source 해 ps_* 함수 본문을 그대로 재사용
# 하고, 그 본문이 의존하는 path-resolver helper (`_filesystem_namespace_dir`,
# `_filesystem_log_path`, `_filesystem_lock_path`) 만 in-memory root 로 재정
# 의한다. 함수 시그니처와 의미는 filesystem 과 동치 — port-conformance 테스트
# (tests/lib/test-port-conformance.sh) 가 이 등가성을 검증한다.

# shellcheck source=./filesystem.sh
. "${LLM_TEAM_ROOT}/adapters/persistent_store/filesystem.sh"

# 루트 확보: 미설정이면 mktemp -d 후 export. 외부에서 미리 export 했다면
# (예: 테스트 격리용) 그 값을 그대로 존중한다.
if [ -z "${LLM_TEAM_INMEM_PS_DIR:-}" ]; then
  LLM_TEAM_INMEM_PS_DIR="$(mktemp -d -t llm-team-inmem-ps.XXXXXX 2>/dev/null \
    || mktemp -d "${TMPDIR:-/tmp}/llm-team-inmem-ps.XXXXXX")"
  export LLM_TEAM_INMEM_PS_DIR
fi

# Override path-resolver helpers from filesystem.sh — 동일 시그니처, in-memory
# root. 모든 public 함수가 이 helper 만 통해 path 를 계산하므로 root 가 바뀌
# 면 (테스트에서 LLM_TEAM_INMEM_PS_DIR 을 다시 export 하는 경우 등) 자동으로
# 격리된다.
_filesystem_namespace_dir() {
  printf '%s/%s' "${LLM_TEAM_INMEM_PS_DIR}" "$1"
}
_filesystem_log_path() {
  printf '%s/%s.jsonl' "${LLM_TEAM_INMEM_PS_DIR}" "$1"
}
_filesystem_lock_path() {
  printf '%s/%s/%s.lockd' "${LLM_TEAM_INMEM_PS_DIR}" "$1" "$2"
}
