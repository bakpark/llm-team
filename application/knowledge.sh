#!/usr/bin/env bash
# application/knowledge.sh
#
# Caller-side writers for the `knowledge` namespace defined by
# docs/contracts/knowledge-contract.md (KAC-ACCUMULATION / KAC-DECISION-LOG /
# KAC-CONTEXT-SUMMARY).
#
# Layout:
#   workdir/<target>/knowledge/context-summaries/<milestone_id>.json
#   workdir/<target>/knowledge/decision-log.jsonl   (append-only)
#
# spec-snapshots namespace 는 KAC-MANIFEST 에서 정의되었으나 milestone body
# 접근용 port 가 아직 없어 이번 PR 에서는 writer 만 두지 않는다 — 후속 PR 에
# port 가 추가되면 함께 wire 한다.
#
# Caller boundary (AGC-CALL-BOUNDARY): pure file IO under workdir/<target>.
# Public functions are best-effort — they never fail the dispatch pipeline.

if [ -z "${LLM_TEAM_ROOT:-}" ]; then
  LLM_TEAM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export LLM_TEAM_ROOT
fi

_knowledge_root() {
  local target="$1"
  printf '%s/workdir/%s/knowledge' "${LLM_TEAM_ROOT}" "${target}"
}

_knowledge_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# knowledge_record_decision <target> <decision_json>
# decision_json 은 임의 JSON 객체. KAC-DECISION-LOG 권장 필드:
#   decision_id, decision, alternatives, rationale, decided_at,
#   affected_milestones, supersedes (optional)
# 본 함수는 decided_at 이 비어 있으면 자동으로 현재 시각을 채워 jsonl 한 줄로
# append 한다. 멱등성은 호출 측이 idempotency_key 등으로 보장한다(append-only).
knowledge_record_decision() {
  local target="$1" decision_json="$2"
  if [ -z "${target}" ] || [ -z "${decision_json}" ]; then
    log_warn "knowledge_record_decision: target and decision_json are required"
    return 0
  fi
  local root log
  root="$(_knowledge_root "${target}")"
  log="${root}/decision-log.jsonl"
  mkdir -p "${root}" || return 0
  printf '%s' "${decision_json}" \
    | jq -c --arg ts "$(_knowledge_now)" '. + (if .decided_at == null or .decided_at == "" then {decided_at: $ts} else {} end)' \
    >>"${log}" 2>/dev/null \
    || log_warn "knowledge_record_decision: append failed for target=${target}"
  return 0
}

# knowledge_snapshot_context_summary <target> <milestone_id> <summary_text>
# QA PASS 시 호출. KAC-CONTEXT-SUMMARY 의 산출물을 저장한다.
knowledge_snapshot_context_summary() {
  local target="$1" ms_id="$2" summary="$3"
  if [ -z "${target}" ] || [ -z "${ms_id}" ] || [ -z "${summary}" ]; then
    return 0
  fi
  local root path
  root="$(_knowledge_root "${target}")/context-summaries"
  mkdir -p "${root}" || return 0
  path="${root}/${ms_id}.json"
  if [ -f "${path}" ]; then
    return 0
  fi
  jq -n \
    --arg milestone_id "${ms_id}" \
    --arg summary "${summary}" \
    --arg saved_at "$(_knowledge_now)" \
    '{milestone_id: $milestone_id, summary: $summary, saved_at: $saved_at}' \
    >"${path}" 2>/dev/null \
    || log_warn "knowledge_snapshot_context_summary: write failed for ${path}"
  return 0
}
