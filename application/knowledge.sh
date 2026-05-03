#!/usr/bin/env bash
# application/knowledge.sh
#
# Caller-side writers for the `knowledge` namespace defined by
# docs/contracts/knowledge-contract.md (KAC-ACCUMULATION / KAC-DECISION-LOG /
# KAC-CONTEXT-SUMMARY).
#
# Layout:
#   workdir/<target>/knowledge/context-summaries/<milestone_id>.json
#   workdir/<target>/knowledge/spec-snapshots/<milestone_id>.json
#   workdir/<target>/knowledge/decision-log.jsonl   (append-only)
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

# knowledge_snapshot_spec <target> <milestone_id> <body_text>
# PO/PM Compose 시 spec body 를 milestone 단위로 freeze 한다(KAC-MANIFEST-FROM-
# KNOWLEDGE). 후속 호출에서 manifest 빌드가 이 snapshot 을 참조해 spec drift 를
# 막는다. append-only: 같은 milestone_id 에 대한 재호출은 가장 최근 본문을
# 다음 manifest 빌드가 보도록 덮어쓴다(spec 은 PO_GATE/PM_GATE 인간 승인 사이클
# 에서 다듬어질 수 있음).
knowledge_snapshot_spec() {
  local target="$1" ms_id="$2" body="$3"
  if [ -z "${target}" ] || [ -z "${ms_id}" ] || [ -z "${body}" ]; then
    return 0
  fi
  local root path tmp
  root="$(_knowledge_root "${target}")/spec-snapshots"
  mkdir -p "${root}" || return 0
  path="${root}/${ms_id}.json"
  tmp="${path}.tmp.$$"
  jq -n \
    --arg milestone_id "${ms_id}" \
    --arg body "${body}" \
    --arg saved_at "$(_knowledge_now)" \
    '{milestone_id: $milestone_id, body: $body, saved_at: $saved_at}' \
    >"${tmp}" 2>/dev/null \
    && mv "${tmp}" "${path}" 2>/dev/null \
    || { rm -f "${tmp}" 2>/dev/null; log_warn "knowledge_snapshot_spec: write failed for ${path}"; }
  return 0
}

# knowledge_latest_prior_summary <target> [exclude_milestone_id]
# 가장 최근 saved context-summary 1건의 (milestone_id\tpath\tsha256_pin) 를
# 출력한다. 매치 없으면 빈 출력 + return 1. exclude_milestone_id 가 주어지면
# 해당 id 의 summary 는 후보에서 제외한다(현재 작업 milestone 자기 참조 회피).
# revision_pin 은 파일 콘텐츠의 sha256 8자리(결정적). 후속 fetch 시 revalidate
# 가 비교용으로 사용한다.
knowledge_latest_prior_summary() {
  local target="$1" exclude="${2:-}"
  local root
  root="$(_knowledge_root "${target}")/context-summaries"
  [ -d "${root}" ] || return 1
  local newest=""
  local f mtime
  while IFS= read -r f; do
    [ -f "${f}" ] || continue
    local base="${f##*/}"
    local id="${base%.json}"
    [ -n "${exclude}" ] && [ "${id}" = "${exclude}" ] && continue
    if [ -z "${newest}" ] || [ "${f}" -nt "${newest}" ]; then
      newest="${f}"
    fi
  done < <(find "${root}" -maxdepth 1 -type f -name '*.json' 2>/dev/null)
  [ -n "${newest}" ] || return 1
  local id pin
  id="$(basename "${newest}" .json)"
  pin="$(shasum -a 256 "${newest}" 2>/dev/null | awk '{print substr($1,1,8)}')"
  [ -n "${pin}" ] || pin="local"
  printf '%s\t%s\t%s\n' "${id}" "${newest}" "summary-${pin}"
}
