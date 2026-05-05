#!/usr/bin/env bash
# lib/markers.sh - marker 문자열 helpers.
#
# 본 파일은 외부 시스템과 결합되지 않은 순수 문자열 빌더만 포함한다.
# 마커가 실제로 GitHub 객체에 존재하는지 조회하는 기능은 이제
# issue_tracker port 의 it_comment_has_marker 가 담당한다.

marker_notified() {
  printf '<!-- llm-team:notified:%s -->' "$1"
}

marker_human_signal_open() {
  printf '<!-- llm-team:human-signal'
}

marker_human_signal_close() {
  printf '%s' '-->'
}
