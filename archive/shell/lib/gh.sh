#!/usr/bin/env bash
# lib/gh.sh — DEPRECATED. Moved to adapters/issue_tracker/github.sh.
#
# 본 파일은 backward-compat 를 위해 비워둔 상태로 잠시 유지된다.
# 모든 함수(gh_with_retry, issue_set_label, milestone_*, …) 의 정식 위치는
# `adapters/issue_tracker/github.sh` 이며, 이 adapter 는 lib/common.sh 에서
# lib/registry.sh 를 통해 자동 source 된다.
#
# 신규 코드는 port API (`it_*`) 를 호출해야 한다.
# 점진 이전이 끝나면 본 파일은 삭제된다.

return 0 2>/dev/null || true
