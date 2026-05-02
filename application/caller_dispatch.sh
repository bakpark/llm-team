#!/usr/bin/env bash
# application/caller_dispatch.sh
#
# Caller-side router that turns an Agent envelope into the full set of side
# effects required by SOC-OPERATIONS / SOC-DEPENDENCIES / SOC-MERGE-POLICY.
#
# Public:
#   caller_apply_output <repo> <role> <envelope_path> <manifest_path>
#       Routes by envelope.output_kind (+ role hint for verdict / package
#       outcomes) to one of 13 branches. Writes one RGC-LEDGER row per call.
#       Idempotent on envelope.idempotency_key.
#   caller_advance_milestone_after_task_integrated <repo> <milestone_num>
#       Sweeper — when every child Task is TASK_INTEGRATED, transitions the
#       milestone IMPLEMENTING → REFACTOR_READY. Otherwise no-op.
#
# Caller boundary (AGC-CALL-BOUNDARY):
#   • application/ → port 함수 (it_* / ws_* / lr_* / nt_* / ps_*) 만 호출.
#   • gh / git / curl / claude 직접 호출 금지. 본 모듈은 그 규약을 준수한다.
#
# Envelope artifact contract (caller 측에서 합의된 키):
#   spec_proposal (PO/PM)
#     artifacts.milestone_body           — milestone description 후보 (옵션)
#     artifacts.cp_artifact_ref          — Spec CP artifact 참조 (옵션)
#   task_plan (Planner)
#     artifacts.tasks[]                  — {slug, title, body}
#     artifacts.dependency_graph         — { slug: [dep_slug, ...], ... }
#     artifacts.integration_branch.name  — 통합 브랜치 명 (옵션, 기본 integration)
#   patch (Coder)
#     artifacts.patch_diff               — unified diff (string)
#     artifacts.commit_message           — git commit 메시지 (옵션, 기본 "task #<n>: apply patch")
#     artifacts.cp_artifact_ref          — 워크스페이스/branch 참조 (옵션)
#     artifacts.task_branch              — 발행 브랜치 (옵션, 기본 llm-team/task-<id>)
#     envelope.target_id                 — issue num (task)
#   verdict (Reviewer)
#     artifacts.verdict                  — "approve" | "request-changes"
#     artifacts.pr_number                — 검토 대상 PR 번호
#     artifacts.cp_path                  — Code CP artifact 경로
#     artifacts.reason                   — request-changes 시 코멘트 본문
#     envelope.target_id                 — issue num (task)
#   milestone_package (Integrator/QA)
#     artifacts.outcome                  — "PASS"|"NO-OP"|"FAIL"|"STALE"
#     artifacts.cp_kind                  — "Integration" | "Milestone"
#     artifacts.cp_path                  — 기존 CP artifact 경로 (FAIL/STALE/NO-OP 시)
#     artifacts.cp_artifact_ref          — 새 CP artifact 참조 (PASS 시 신규 생성)
#     artifacts.pr_number                — 통합/마일스톤 PR 번호 (옵션)
#     artifacts.failing_tasks[]          — QA FAIL 시 책임 task issue num 배열
#     artifacts.integrator_attempt       — 재시도 카운트 (Integrator FAIL 시)
#     envelope.target_id                 — milestone num
#
# RGC-LEDGER:
#   • 모든 분기 끝에서 _caller_ledger_write 가 13개 표준 필드를 채워 한 줄 기록.
#   • 같은 idempotency_key 가 이미 ledger 에 있으면 부작용 skip + duplicate=true.

# ============================================================================
# Internal helpers
# ============================================================================

_caller_now()    { date -u +%Y-%m-%dT%H:%M:%SZ; }
_caller_uuid()   { printf 'tx-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$$-${RANDOM}-${RANDOM}"; }

# Resolve target name from environment. caller_apply_output requires TARGET_NAME
# (or workdir-target) to be set so CP / ledger paths resolve.
_caller_target() {
  printf '%s' "${TARGET_NAME:-${LLM_TEAM_TARGET:-}}"
}

_caller_caller_id() { printf '%s' "${LLM_TEAM_CALLER_ID:-caller_dispatch}"; }

# True (rc=0) if ledger already records this idempotency_key as a successful
# application. Failure rows (result=error|stale|invalid) do NOT count: per
# RGC-FAILURE the transient failures must remain retryable, otherwise a single
# adapter glitch permanently locks the next scheduled attempt out as a
# spurious duplicate.
_caller_ledger_has_key() {
  local target="$1" key="$2"
  local path
  path="$(transition_ledger_path "${target}")"
  [ -f "${path}" ] || return 1
  jq -e --arg k "${key}" \
    'select(.idempotency_key == $k) | select((.result // "") == "applied" or (.result // "") == "duplicate")' \
    "${path}" >/dev/null 2>&1
}

# _caller_ledger_write target object_kind object_id from_state to_state \
#                      operation idempotency_key manifest_id [extra-jq-program]
_caller_ledger_write() {
  local target="$1" object_kind="$2" object_id="$3" from_state="$4" to_state="$5"
  local operation="$6" idempotency_key="$7" manifest_id="$8" extra_program="${9:-.}"
  local entry tmp
  tmp="$(mktemp -t caller-ledger.XXXXXX)" || {
    log_error "_caller_ledger_write: mktemp failed"
    return 1
  }
  jq -n \
    --arg transition_id "$(_caller_uuid)" \
    --arg object_kind "${object_kind}" \
    --arg object_id "${object_id}" \
    --arg from_state "${from_state}" \
    --arg to_state "${to_state}" \
    --arg operation "${operation}" \
    --arg caller_id "$(_caller_caller_id)" \
    --arg idempotency_key "${idempotency_key}" \
    --arg manifest_id "${manifest_id}" \
    --arg timestamp "$(_caller_now)" \
    "{
       transition_id: \$transition_id,
       object_kind: \$object_kind,
       object_id: \$object_id,
       from_state: \$from_state,
       to_state: \$to_state,
       operation: \$operation,
       caller_id: \$caller_id,
       idempotency_key: \$idempotency_key,
       manifest_id: \$manifest_id,
       timestamp: \$timestamp,
       result: \"applied\",
       duplicate: false
     } | ${extra_program}" >"${tmp}" || {
       log_error "_caller_ledger_write: jq build failed"
       rm -f "${tmp}"
       return 1
     }
  if ! transition_ledger_write "${target}" "${tmp}"; then
    rm -f "${tmp}"
    return 1
  fi
  rm -f "${tmp}"
}

# Write a duplicate marker for an already-applied idempotency_key (no other
# side effects).
_caller_ledger_write_duplicate() {
  local target="$1" idempotency_key="$2" operation="$3" object_kind="$4" object_id="$5" manifest_id="$6"
  _caller_ledger_write "${target}" "${object_kind}" "${object_id}" "(duplicate)" "(duplicate)" \
    "${operation}" "${idempotency_key}" "${manifest_id}" \
    '. + { result: "duplicate", duplicate: true }'
}

# Detect cycle in a dependency_graph object: { node: [dep, ...], ... }.
# Returns 0 if no cycle; non-zero (and stderr "cycle: a → b → a") if a cycle exists.
_caller_check_dependency_cycle() {
  local graph_json="$1"
  if [ -z "${graph_json}" ] || [ "${graph_json}" = "null" ]; then
    return 0
  fi
  local cycle
  cycle="$(printf '%s' "${graph_json}" | jq -r '
    . as $g
    | (keys // []) as $nodes
    | reduce $nodes[] as $start
        ({found: null};
          if .found != null then . else
            ({stack: [$start], visited: {($start):true}, path: [$start]}) as $init
            | reduce range(0; ($g[$start] // []) | length) as $i
                ($init;
                  if .found? != null then . else . end)
            | .found = (
                # Iterative DFS using jq foreach
                (foreach (
                  ($g | recurse_down=null)  # placeholder; we build manually
                ) as $_ (.; .))
              )
            | .
          end)
    | empty
  ' 2>/dev/null || true)"
  # The pure-jq DFS above is finicky; do a direct bash DFS instead.
  _caller_check_dependency_cycle_bash "${graph_json}"
}

# Bash DFS-based cycle detector. Easier to reason about than jq recursion.
_caller_check_dependency_cycle_bash() {
  local graph_json="$1"
  if [ -z "${graph_json}" ] || [ "${graph_json}" = "null" ]; then
    return 0
  fi
  # Build node list.
  local nodes
  nodes="$(printf '%s' "${graph_json}" | jq -r 'keys[]?')"
  local node
  while IFS= read -r node; do
    [ -n "${node}" ] || continue
    local trail
    trail="$(_caller_dfs "${graph_json}" "${node}" "${node}")"
    if [ -n "${trail}" ]; then
      log_error "cycle: ${trail}"
      return 1
    fi
  done <<<"${nodes}"
  return 0
}

# DFS from start; returns "a → b → a" trail if cycle; empty otherwise.
_caller_dfs() {
  local graph_json="$1" start="$2" current="$3"
  local visited="${4:- }"  # space-padded list "  a  b  "
  local path="${5:-${start}}"
  # If current already in visited (excluding start) → cycle within branch.
  case " ${visited} " in
    *" ${current} "*)
      printf '%s → %s' "${path}" "${current}"
      return 0
      ;;
  esac
  visited="${visited} ${current}"
  local deps
  deps="$(printf '%s' "${graph_json}" | jq -r --arg n "${current}" '.[$n][]?')"
  local d
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    if [ "${d}" = "${start}" ]; then
      printf '%s → %s' "${path}" "${d}"
      return 0
    fi
    local sub
    sub="$(_caller_dfs "${graph_json}" "${start}" "${d}" "${visited}" "${path} → ${d}")"
    if [ -n "${sub}" ]; then
      printf '%s' "${sub}"
      return 0
    fi
  done <<<"${deps}"
  return 0
}

# ============================================================================
# Public: caller_apply_output
# ============================================================================

caller_apply_output() {
  local repo="$1" role="$2" envelope_path="$3" manifest_path="$4"
  if [ -z "${repo}" ] || [ -z "${role}" ] || [ -z "${envelope_path}" ] || [ -z "${manifest_path}" ]; then
    log_error "caller_apply_output: repo, role, envelope_path, manifest_path are required"
    return 1
  fi
  if [ ! -f "${envelope_path}" ]; then
    log_error "caller_apply_output: envelope not found: ${envelope_path}"
    return 1
  fi
  local target
  target="$(_caller_target)"
  if [ -z "${target}" ]; then
    log_error "caller_apply_output: TARGET_NAME (or LLM_TEAM_TARGET) not set"
    return 1
  fi
  local output_kind idempotency_key target_id manifest_id operation
  output_kind="$(jq -r '.output_kind // empty' "${envelope_path}")"
  idempotency_key="$(jq -r '.idempotency_key // empty' "${envelope_path}")"
  target_id="$(jq -r '.target_id // empty' "${envelope_path}")"
  manifest_id="$(jq -r '.manifest_id // empty' "${envelope_path}")"
  operation="$(jq -r '.operation // empty' "${envelope_path}")"
  if [ -z "${output_kind}" ] || [ -z "${idempotency_key}" ] || [ -z "${target_id}" ]; then
    log_error "caller_apply_output: envelope missing output_kind/idempotency_key/target_id"
    return 1
  fi
  target_id="$(_caller_target_id_strip_kind "${target_id}")"

  # SOC-IDEMPOTENCY: short-circuit duplicate.
  if _caller_ledger_has_key "${target}" "${idempotency_key}"; then
    log_info "caller_apply_output: duplicate idempotency_key='${idempotency_key}' — recording duplicate marker"
    _caller_ledger_write_duplicate "${target}" "${idempotency_key}" "${operation}" \
      "$(_caller_object_kind_for_role "${role}" "${output_kind}")" "${target_id}" "${manifest_id}"
    return 0
  fi

  case "${output_kind}" in
    spec_proposal)
      case "$(_caller_role_norm "${role}")" in
        po) _caller_apply_spec_proposal "${repo}" "${target}" PO "${envelope_path}" \
              "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}" ;;
        pm) _caller_apply_spec_proposal "${repo}" "${target}" PM "${envelope_path}" \
              "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}" ;;
        *)  log_error "caller_apply_output: spec_proposal must come from PO or PM (got '${role}')"; return 1 ;;
      esac
      ;;
    task_plan)
      _caller_apply_task_plan "${repo}" "${target}" "${envelope_path}" \
        "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}"
      ;;
    patch)
      _caller_apply_patch "${repo}" "${target}" "${envelope_path}" \
        "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}"
      ;;
    verdict)
      _caller_apply_verdict "${repo}" "${target}" "${envelope_path}" \
        "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}"
      ;;
    milestone_package)
      _caller_apply_milestone_package "${repo}" "${target}" "${role}" "${envelope_path}" \
        "${target_id}" "${manifest_id}" "${idempotency_key}" "${operation}"
      ;;
    failure)
      log_warn "caller_apply_output: envelope reports output_kind=failure; recording ledger only"
      _caller_ledger_write "${target}" "envelope" "${target_id}" "(failure)" "(failure)" \
        "${operation}" "${idempotency_key}" "${manifest_id}"
      ;;
    *)
      log_error "caller_apply_output: unknown output_kind '${output_kind}'"
      return 1
      ;;
  esac
}

_caller_role_norm() {
  case "$1" in
    po|PO) printf 'po' ;;
    pm|PM) printf 'pm' ;;
    planner|Planner) printf 'planner' ;;
    coder|Coder) printf 'coder' ;;
    reviewer|Reviewer) printf 'reviewer' ;;
    integrator|Integrator) printf 'integrator' ;;
    qa|QA) printf 'qa' ;;
    *) return 1 ;;
  esac
}

_caller_object_kind_for_role() {
  local role="$1" kind="$2"
  case "$(_caller_role_norm "${role}")" in
    po|pm|planner|integrator|qa) printf 'milestone' ;;
    coder|reviewer)              printf 'task' ;;
    *) printf 'envelope' ;;
  esac
}

# Normalize envelope.target_id by stripping a leading "<kind>:" segment for
# adapter-level numeric ids (milestone, task, issue). Hierarchical CP ids
# ("cp:code:...") are preserved.
#
# Per prompts/*.md the LLM emits target_id like "milestone:42" / "task:7", but
# legacy test fixtures and the GitHub adapters expect bare numeric ids. The
# contract documents (AGC-OUTPUT) do not mandate a specific format, so the
# adapter layer absorbs both forms here.
_caller_target_id_strip_kind() {
  local raw="${1:-}"
  case "${raw}" in
    milestone:*|task:*|issue:*) printf '%s' "${raw#*:}" ;;
    *) printf '%s' "${raw}" ;;
  esac
}

# ============================================================================
# Branch 1/2: spec_proposal (PO / PM)
# ============================================================================

# Args: repo target role(PO|PM) envelope_path target_id manifest_id idem_key operation
_caller_apply_spec_proposal() {
  local repo="$1" target="$2" role="$3" env_path="$4"
  local target_id="$5" manifest_id="$6" idem_key="$7" operation="$8"

  local from_state to_state notify_kind
  case "${role}" in
    PO) from_state=PO_DRAFT; to_state=PO_GATE; notify_kind="human-gate:po" ;;
    PM) from_state=PM_DRAFT; to_state=PM_GATE; notify_kind="human-gate:pm" ;;
    *)  log_error "_caller_apply_spec_proposal: unknown role '${role}'"; return 1 ;;
  esac

  # Validate spec content BEFORE creating any CP / setting CP state. prompts/po.md
  # and prompts/pm.md document the field as `milestone_body_proposal`; legacy
  # callers may still emit `milestone_body`. A structurally valid envelope with
  # no spec content would otherwise advance state to *_GATE with nothing for a
  # human reviewer to read. Validating up front also avoids leaving an orphan
  # CP file in CP_READY_FOR_HUMAN_GATE on retry when only the body was missing.
  local body
  body="$(jq -r '.artifacts.milestone_body_proposal // .artifacts.milestone_body // empty' "${env_path}")"
  if [ -z "${body}" ]; then
    log_error "_caller_apply_spec_proposal: ${role} envelope missing artifacts.milestone_body_proposal"
    return 1
  fi

  local artifact_ref
  artifact_ref="$(jq -r '.artifacts.cp_artifact_ref // empty' "${env_path}")"
  local cp_path
  cp_path="$(change_proposal_create "${target}" Spec "${role}" "${operation}" "${target_id}" "${artifact_ref}")" \
    || { log_error "_caller_apply_spec_proposal: change_proposal_create failed"; return 1; }

  change_proposal_set_state "${cp_path}" CP_READY_FOR_HUMAN_GATE CP_DRAFT \
    || { log_error "_caller_apply_spec_proposal: CP CP_DRAFT→CP_READY_FOR_HUMAN_GATE failed"; return 1; }

  it_milestone_update "${repo}" "${target_id}" --body "${body}" \
    || { log_error "_caller_apply_spec_proposal: milestone_update body failed"; return 1; }

  it_milestone_set_state "${repo}" "${target_id}" "${to_state}" "${from_state}" \
    || { log_error "_caller_apply_spec_proposal: milestone ${from_state}→${to_state} failed"; return 1; }

  # Notification (Caller-only — RGC-NOTIFICATION). 본 호출은 best-effort —
  # target yaml 이 로드되지 않았거나 notifier adapter 가 'none' 이어도 워크
  # 플로우를 중단하지 않는다.
  if declare -F notify_review_needed >/dev/null 2>&1 \
     && [ -n "${TARGET_GH_OWNER:-}" ] && [ -n "${TARGET_GH_REPO:-}" ]; then
    ( notify_review_needed "${target}" "${notify_kind}" milestone "${target_id}" "" \
        "${role} spec ready for human gate (milestone #${target_id})" ) || true
  fi

  _caller_ledger_write "${target}" milestone "${target_id}" "${from_state}" "${to_state}" \
    "${operation}" "${idem_key}" "${manifest_id}" \
    ". + { cp_path: \"${cp_path}\" }"
}

# ============================================================================
# Branch 3: task_plan (Planner)
# ============================================================================

_caller_apply_task_plan() {
  local repo="$1" target="$2" env_path="$3"
  local target_id="$4" manifest_id="$5" idem_key="$6" operation="$7"

  local graph
  graph="$(jq -c '.artifacts.dependency_graph // {}' "${env_path}")"
  if ! _caller_check_dependency_cycle_bash "${graph}"; then
    log_error "_caller_apply_task_plan: dependency cycle in dependency_graph"
    return 1
  fi

  # Optional integration branch publish (best effort; ws_ensure_clone may not
  # be available in test environments).
  local integration_branch
  integration_branch="$(jq -r '.artifacts.integration_branch.name // empty' "${env_path}")"
  if [ -n "${integration_branch}" ] && declare -F ws_ensure_clone >/dev/null 2>&1; then
    ws_ensure_clone "${target}" >/dev/null 2>&1 || \
      log_warn "_caller_apply_task_plan: ws_ensure_clone failed; continuing without canonical clone"
  fi

  # Create one issue per task.
  local tasks
  tasks="$(jq -c '.artifacts.tasks // []' "${env_path}")"
  local count
  count="$(printf '%s' "${tasks}" | jq 'length')"
  if [ "${count}" -eq 0 ]; then
    # Fail-fast: an empty task list silently advances milestone to IMPLEMENTING
    # with no work for Coder, defeating the Decompose stage entirely. Reject so
    # the runner records `error` and the milestone stays at DECOMPOSE_READY for
    # retry, mirroring the spec_proposal empty-body guard.
    log_error "_caller_apply_task_plan: artifacts.tasks is empty"
    return 1
  fi

  # slug → issue_num map (bash 3.2 compatible — flat parallel arrays).
  local -a slugs=() nums=()
  local i
  for ((i=0; i<count; i++)); do
    local slug title body
    slug="$(printf '%s' "${tasks}" | jq -r ".[${i}].slug // empty")"
    title="$(printf '%s' "${tasks}" | jq -r ".[${i}].title // empty")"
    body="$(printf '%s' "${tasks}" | jq -r ".[${i}].body // empty")"
    if [ -z "${slug}" ] || [ -z "${title}" ]; then
      log_error "_caller_apply_task_plan: task[${i}] missing slug/title"
      return 1
    fi
    local issue_num
    issue_num="$(it_issue_create "${repo}" --title "${title}" --body "${body}" --milestone "${target_id}")" \
      || { log_error "_caller_apply_task_plan: it_issue_create failed for slug='${slug}'"; return 1; }
    slugs+=("${slug}")
    nums+=("${issue_num}")
  done

  # Wire blocked_by + initial state (READY if no deps; PENDING otherwise).
  for ((i=0; i<count; i++)); do
    local slug="${slugs[${i}]}"
    local issue_num="${nums[${i}]}"
    local deps blocker_nums=() dep j
    deps="$(printf '%s' "${graph}" | jq -r --arg s "${slug}" '.[$s][]?')"
    while IFS= read -r dep; do
      [ -n "${dep}" ] || continue
      # Linear lookup in parallel arrays.
      for ((j=0; j<${#slugs[@]}; j++)); do
        if [ "${slugs[${j}]}" = "${dep}" ]; then
          blocker_nums+=("${nums[${j}]}")
          break
        fi
      done
    done <<<"${deps}"
    if [ "${#blocker_nums[@]}" -gt 0 ]; then
      it_issue_set_blocked_by "${repo}" "${issue_num}" "${blocker_nums[@]}" \
        || log_warn "_caller_apply_task_plan: set_blocked_by failed for issue #${issue_num}"
      it_issue_set_state "${repo}" "${issue_num}" TASK_PENDING \
        || { log_error "_caller_apply_task_plan: TASK_PENDING set failed for #${issue_num}"; return 1; }
    else
      it_issue_set_state "${repo}" "${issue_num}" TASK_READY \
        || { log_error "_caller_apply_task_plan: TASK_READY set failed for #${issue_num}"; return 1; }
    fi
  done

  it_milestone_set_state "${repo}" "${target_id}" IMPLEMENTING DECOMPOSE_IN_PROGRESS \
    || { log_error "_caller_apply_task_plan: milestone DECOMPOSE_IN_PROGRESS→IMPLEMENTING failed"; return 1; }

  _caller_ledger_write "${target}" milestone "${target_id}" DECOMPOSE_IN_PROGRESS IMPLEMENTING \
    "${operation}" "${idem_key}" "${manifest_id}" \
    ". + { tasks_created: ${count} }"
}

# ============================================================================
# Branch 4: patch (Coder)
# ============================================================================

_caller_apply_patch() {
  local repo="$1" target="$2" env_path="$3"
  local issue_num="$4" manifest_id="$5" idem_key="$6" operation="$7"

  local unit_id branch
  unit_id="task-${issue_num}"
  branch="$(jq -r '.artifacts.task_branch // empty' "${env_path}")"
  [ -n "${branch}" ] || branch="llm-team/${unit_id}"

  # Apply the patch (workspace is expected to already exist via runner.sh).
  local patch_text
  patch_text="$(jq -r '.artifacts.patch_diff // empty' "${env_path}")"
  if [ -z "${patch_text}" ]; then
    log_error "_caller_apply_patch: envelope.artifacts.patch_diff is empty"
    return 1
  fi
  if declare -F ws_apply_patch >/dev/null 2>&1; then
    local commit_message
    commit_message="$(jq -r '.artifacts.commit_message // empty' "${env_path}")"
    [ -n "${commit_message}" ] || commit_message="task #${issue_num}: apply patch"
    ws_apply_patch "${unit_id}" "${patch_text}" "${commit_message}" \
      || { log_error "_caller_apply_patch: ws_apply_patch failed"; return 1; }
    if declare -F ws_publish_branch >/dev/null 2>&1; then
      ws_publish_branch "${unit_id}" "${branch}" \
        || log_warn "_caller_apply_patch: ws_publish_branch failed (continuing for in-memory tests)"
    fi
  fi

  local artifact_ref
  artifact_ref="$(jq -r '.artifacts.cp_artifact_ref // empty' "${env_path}")"
  [ -n "${artifact_ref}" ] || artifact_ref="branch:${branch}"
  local cp_path
  cp_path="$(change_proposal_create "${target}" Code Coder "${operation}" "${issue_num}" "${artifact_ref}")" \
    || { log_error "_caller_apply_patch: change_proposal_create failed"; return 1; }

  # Open PR (base = integration branch).
  local pr_base
  pr_base="${LLM_TEAM_INTEGRATION_BRANCH:-integration}"
  local pr_num
  pr_num="$(it_pr_create "${repo}" --head "${branch}" --base "${pr_base}" \
              --title "task #${issue_num}" \
              --body "$(printf 'Code CP for task #%s.\n\nbranch: %s\n' "${issue_num}" "${branch}")")" \
    || { log_error "_caller_apply_patch: it_pr_create failed"; return 1; }

  change_proposal_set_pr_link "${cp_path}" "${pr_num}" \
    || log_warn "_caller_apply_patch: change_proposal_set_pr_link failed"
  change_proposal_set_state "${cp_path}" CP_READY_FOR_REVIEW CP_DRAFT \
    || { log_error "_caller_apply_patch: CP CP_DRAFT→CP_READY_FOR_REVIEW failed"; return 1; }
  it_pr_set_cp_state "${repo}" "${pr_num}" CP_READY_FOR_REVIEW \
    || { log_error "_caller_apply_patch: it_pr_set_cp_state failed"; return 1; }
  it_issue_set_state "${repo}" "${issue_num}" TASK_REVIEW_READY TASK_IN_PROGRESS \
    || { log_error "_caller_apply_patch: issue TASK_IN_PROGRESS→TASK_REVIEW_READY failed"; return 1; }

  _caller_ledger_write "${target}" task "${issue_num}" TASK_IN_PROGRESS TASK_REVIEW_READY \
    "${operation}" "${idem_key}" "${manifest_id}" \
    ". + { cp_path: \"${cp_path}\", pr_number: ${pr_num} }"
}

# ============================================================================
# Branch 5/6: verdict (Reviewer — approve / request-changes)
# ============================================================================

_caller_apply_verdict() {
  local repo="$1" target="$2" env_path="$3"
  local issue_num="$4" manifest_id="$5" idem_key="$6" operation="$7"

  local verdict pr_num cp_path reason
  verdict="$(jq -r '.artifacts.verdict // empty' "${env_path}")"
  pr_num="$(jq -r '.artifacts.pr_number // empty' "${env_path}")"
  cp_path="$(jq -r '.artifacts.cp_path // empty' "${env_path}")"
  reason="$(jq -r '.artifacts.reason // empty' "${env_path}")"

  if [ -z "${verdict}" ] || [ -z "${pr_num}" ] || [ -z "${cp_path}" ]; then
    log_error "_caller_apply_verdict: artifacts.verdict / .pr_number / .cp_path are required"
    return 1
  fi
  case "${verdict}" in
    approve|request-changes) ;;
    *) log_error "_caller_apply_verdict: unknown verdict '${verdict}'"; return 1 ;;
  esac

  if [ "${verdict}" = "request-changes" ]; then
    [ -n "${reason}" ] || reason="Reviewer requested changes."
    change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES CP_READY_FOR_REVIEW \
      || { log_error "_caller_apply_verdict: CP →CP_REQUEST_CHANGES failed"; return 1; }
    change_proposal_set_state "${cp_path}" CP_CLOSED CP_REQUEST_CHANGES \
      || { log_error "_caller_apply_verdict: CP →CP_CLOSED failed"; return 1; }
    it_pr_close "${repo}" "${pr_num}" \
      || log_warn "_caller_apply_verdict: it_pr_close failed for PR #${pr_num}"
    it_pr_request_changes "${repo}" "${pr_num}" "${reason}" \
      || log_warn "_caller_apply_verdict: it_pr_request_changes failed for PR #${pr_num}"
    it_issue_set_state "${repo}" "${issue_num}" TASK_REJECTED TASK_REVIEW_IN_PROGRESS \
      || { log_error "_caller_apply_verdict: issue →TASK_REJECTED failed"; return 1; }
    it_issue_set_state "${repo}" "${issue_num}" TASK_READY TASK_REJECTED \
      || { log_error "_caller_apply_verdict: issue →TASK_READY failed"; return 1; }
    _caller_ledger_write "${target}" task "${issue_num}" TASK_REVIEW_IN_PROGRESS TASK_READY \
      "${operation}" "${idem_key}" "${manifest_id}" \
      ". + { verdict: \"request-changes\", cp_path: \"${cp_path}\", pr_number: ${pr_num} }"
    return 0
  fi

  # ----- approve: SOC-MERGE-POLICY -----
  local pr_base_sha integration_head
  pr_base_sha="$(it_pr_get_base_sha "${repo}" "${pr_num}" 2>/dev/null)"
  local integration_branch
  integration_branch="$(it_pr_get_base_branch "${repo}" "${pr_num}" 2>/dev/null)"
  [ -n "${integration_branch}" ] || integration_branch="${LLM_TEAM_INTEGRATION_BRANCH:-integration}"
  if declare -F ws_get_branch_head >/dev/null 2>&1; then
    integration_head="$(ws_get_branch_head "${target}" "${integration_branch}" 2>/dev/null)"
  fi
  if [ -n "${integration_head}" ] && [ -n "${pr_base_sha}" ] && [ "${pr_base_sha}" != "${integration_head}" ]; then
    # STALE: integration moved since PR created.
    change_proposal_set_state "${cp_path}" CP_STALE \
      || log_warn "_caller_apply_verdict: CP →CP_STALE failed"
    it_pr_set_cp_state "${repo}" "${pr_num}" CP_STALE \
      || log_warn "_caller_apply_verdict: PR →CP_STALE failed"
    it_issue_set_state "${repo}" "${issue_num}" TASK_READY TASK_REVIEW_IN_PROGRESS \
      || log_warn "_caller_apply_verdict: issue TASK_REVIEW_IN_PROGRESS→TASK_READY failed"
    _caller_ledger_write "${target}" task "${issue_num}" TASK_REVIEW_IN_PROGRESS TASK_READY \
      "${operation}" "${idem_key}" "${manifest_id}" \
      ". + { verdict: \"approve-stale\", cp_path: \"${cp_path}\", pr_number: ${pr_num} }"
    return 0
  fi

  # Clean approve → merge.
  change_proposal_set_state "${cp_path}" CP_APPROVED CP_READY_FOR_REVIEW \
    || { log_error "_caller_apply_verdict: CP CP_READY_FOR_REVIEW→CP_APPROVED failed"; return 1; }
  it_pr_set_cp_state "${repo}" "${pr_num}" CP_APPROVED CP_READY_FOR_REVIEW \
    || log_warn "_caller_apply_verdict: PR cp-state CP_APPROVED set failed"
  it_pr_merge "${repo}" "${pr_num}" --squash >/dev/null \
    || { log_error "_caller_apply_verdict: it_pr_merge failed for PR #${pr_num}"; return 1; }
  change_proposal_set_state "${cp_path}" CP_MERGED CP_APPROVED \
    || log_warn "_caller_apply_verdict: CP CP_APPROVED→CP_MERGED failed"
  it_issue_set_state "${repo}" "${issue_num}" TASK_INTEGRATED TASK_REVIEW_IN_PROGRESS \
    || { log_error "_caller_apply_verdict: issue TASK_REVIEW_IN_PROGRESS→TASK_INTEGRATED failed"; return 1; }

  # H3: PR merged → unit worktree 와 task 브랜치 정리(idempotent).
  if declare -F workspace_prune_unit >/dev/null 2>&1; then
    workspace_prune_unit "${target}" "task-${issue_num}" || true
  fi

  # Sweep milestone if all children integrated.
  local ms_num
  ms_num="$(it_issue_get_milestone "${repo}" "${issue_num}" 2>/dev/null)"
  if [ -n "${ms_num}" ]; then
    caller_advance_milestone_after_task_integrated "${repo}" "${ms_num}" || true
  fi

  _caller_ledger_write "${target}" task "${issue_num}" TASK_REVIEW_IN_PROGRESS TASK_INTEGRATED \
    "${operation}" "${idem_key}" "${manifest_id}" \
    ". + { verdict: \"approve\", cp_path: \"${cp_path}\", pr_number: ${pr_num} }"
}

# ============================================================================
# Branch 7-13: milestone_package (Integrator / QA — PASS / NO-OP / FAIL / STALE)
# ============================================================================

_caller_apply_milestone_package() {
  local repo="$1" target="$2" role="$3" env_path="$4"
  local ms_num="$5" manifest_id="$6" idem_key="$7" operation="$8"

  local outcome cp_kind cp_path artifact_ref pr_num
  outcome="$(jq -r '.artifacts.outcome // empty' "${env_path}")"
  cp_kind="$(jq -r '.artifacts.cp_kind // empty' "${env_path}")"
  cp_path="$(jq -r '.artifacts.cp_path // empty' "${env_path}")"
  artifact_ref="$(jq -r '.artifacts.cp_artifact_ref // empty' "${env_path}")"
  pr_num="$(jq -r '.artifacts.pr_number // empty' "${env_path}")"

  if [ -z "${outcome}" ]; then
    log_error "_caller_apply_milestone_package: artifacts.outcome is required"
    return 1
  fi

  case "$(_caller_role_norm "${role}")" in
    integrator) _caller_apply_integrator_pkg "${repo}" "${target}" "${env_path}" \
                  "${ms_num}" "${manifest_id}" "${idem_key}" "${operation}" \
                  "${outcome}" "${cp_kind}" "${cp_path}" "${artifact_ref}" "${pr_num}" ;;
    qa)         _caller_apply_qa_pkg "${repo}" "${target}" "${env_path}" \
                  "${ms_num}" "${manifest_id}" "${idem_key}" "${operation}" \
                  "${outcome}" "${cp_path}" "${artifact_ref}" "${pr_num}" ;;
    *)
      log_error "_caller_apply_milestone_package: role must be Integrator or QA (got '${role}')"
      return 1
      ;;
  esac
}

_caller_apply_integrator_pkg() {
  local repo="$1" target="$2" env_path="$3"
  local ms_num="$4" manifest_id="$5" idem_key="$6" operation="$7"
  local outcome="$8" cp_kind="$9" cp_path="${10}" artifact_ref="${11}" pr_num="${12}"

  case "${outcome}" in
    NO-OP)
      # No CP; just advance milestone state.
      it_milestone_set_state "${repo}" "${ms_num}" VALIDATE_READY REFACTOR_IN_PROGRESS \
        || { log_error "_caller_apply_integrator_pkg/NO-OP: milestone REFACTOR_IN_PROGRESS→VALIDATE_READY failed"; return 1; }
      _caller_ledger_write "${target}" milestone "${ms_num}" REFACTOR_IN_PROGRESS VALIDATE_READY \
        "${operation}" "${idem_key}" "${manifest_id}" \
        '. + { outcome: "NO-OP", cp_kind: "Integration" }'
      ;;
    PASS)
      # Build a new Integration CP and walk it CP_DRAFT → CP_READY_FOR_VERIFICATION → CP_APPROVED → CP_MERGED.
      local new_cp
      new_cp="$(change_proposal_create "${target}" Integration Integrator "${operation}" "${ms_num}" "${artifact_ref}")" \
        || { log_error "_caller_apply_integrator_pkg/PASS: change_proposal_create failed"; return 1; }
      change_proposal_set_state "${new_cp}" CP_READY_FOR_VERIFICATION CP_DRAFT || return 1
      change_proposal_set_state "${new_cp}" CP_APPROVED CP_READY_FOR_VERIFICATION || return 1
      change_proposal_set_state "${new_cp}" CP_MERGED CP_APPROVED || return 1
      if [ -n "${pr_num}" ]; then
        change_proposal_set_pr_link "${new_cp}" "${pr_num}" || true
        it_pr_merge "${repo}" "${pr_num}" --squash >/dev/null \
          || log_warn "_caller_apply_integrator_pkg/PASS: it_pr_merge failed (continuing)"
      fi
      it_milestone_set_state "${repo}" "${ms_num}" VALIDATE_READY REFACTOR_IN_PROGRESS \
        || { log_error "_caller_apply_integrator_pkg/PASS: milestone transition failed"; return 1; }
      # KAC-DECISION-LOG: integration PASS 자체가 1급 결정. append-only.
      if declare -F knowledge_record_decision >/dev/null 2>&1; then
        local decision_json
        decision_json="$(jq -n \
          --arg decision_id "integrator-pass-${ms_num}-${idem_key}" \
          --arg decision "Integration PASS for milestone #${ms_num}" \
          --arg rationale "$(jq -r '.summary // empty' "${env_path}")" \
          --arg cp_path "${new_cp}" \
          --arg ms_id "${ms_num}" \
          '{decision_id: $decision_id, decision: $decision, rationale: $rationale, cp_path: $cp_path, affected_milestones: [$ms_id]}')"
        knowledge_record_decision "${target}" "${decision_json}" || true
      fi
      _caller_ledger_write "${target}" milestone "${ms_num}" REFACTOR_IN_PROGRESS VALIDATE_READY \
        "${operation}" "${idem_key}" "${manifest_id}" \
        ". + { outcome: \"PASS\", cp_kind: \"Integration\", cp_path: \"${new_cp}\" }"
      ;;
    FAIL)
      local attempt
      attempt="$(jq -r '.artifacts.integrator_attempt // 1' "${env_path}")"
      local max_attempts="${LLM_TEAM_INTEGRATOR_MAX_ATTEMPTS:-3}"
      if [ -n "${cp_path}" ]; then
        change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES \
          || log_warn "_caller_apply_integrator_pkg/FAIL: CP →CP_REQUEST_CHANGES failed"
        change_proposal_set_state "${cp_path}" CP_CLOSED CP_REQUEST_CHANGES \
          || log_warn "_caller_apply_integrator_pkg/FAIL: CP →CP_CLOSED failed"
      fi
      if [ -n "${pr_num}" ]; then
        it_pr_close "${repo}" "${pr_num}" \
          || log_warn "_caller_apply_integrator_pkg/FAIL: it_pr_close failed"
      fi
      if [ "${attempt}" -ge "${max_attempts}" ]; then
        it_milestone_set_state "${repo}" "${ms_num}" ESCALATED REFACTOR_IN_PROGRESS \
          || log_warn "_caller_apply_integrator_pkg/FAIL: milestone →ESCALATED failed"
        _caller_ledger_write "${target}" milestone "${ms_num}" REFACTOR_IN_PROGRESS ESCALATED \
          "${operation}" "${idem_key}" "${manifest_id}" \
          ". + { outcome: \"FAIL\", attempt: ${attempt}, escalated: true }"
      else
        it_milestone_set_state "${repo}" "${ms_num}" REFACTOR_READY REFACTOR_IN_PROGRESS \
          || { log_error "_caller_apply_integrator_pkg/FAIL: milestone REFACTOR_IN_PROGRESS→REFACTOR_READY failed"; return 1; }
        _caller_ledger_write "${target}" milestone "${ms_num}" REFACTOR_IN_PROGRESS REFACTOR_READY \
          "${operation}" "${idem_key}" "${manifest_id}" \
          ". + { outcome: \"FAIL\", attempt: ${attempt} }"
      fi
      ;;
    STALE)
      if [ -n "${cp_path}" ]; then
        change_proposal_set_state "${cp_path}" CP_STALE \
          || log_warn "_caller_apply_integrator_pkg/STALE: CP →CP_STALE failed"
      fi
      it_milestone_set_state "${repo}" "${ms_num}" REFACTOR_READY REFACTOR_IN_PROGRESS \
        || { log_error "_caller_apply_integrator_pkg/STALE: milestone transition failed"; return 1; }
      _caller_ledger_write "${target}" milestone "${ms_num}" REFACTOR_IN_PROGRESS REFACTOR_READY \
        "${operation}" "${idem_key}" "${manifest_id}" \
        '. + { outcome: "STALE", cp_kind: "Integration" }'
      ;;
    *)
      log_error "_caller_apply_integrator_pkg: unknown outcome '${outcome}'"
      return 1
      ;;
  esac
}

_caller_apply_qa_pkg() {
  local repo="$1" target="$2" env_path="$3"
  local ms_num="$4" manifest_id="$5" idem_key="$6" operation="$7"
  local outcome="$8" cp_path="$9" artifact_ref="${10}" pr_num="${11}"

  case "${outcome}" in
    PASS)
      local new_cp
      new_cp="$(change_proposal_create "${target}" Milestone QA "${operation}" "${ms_num}" "${artifact_ref}")" \
        || { log_error "_caller_apply_qa_pkg/PASS: change_proposal_create failed"; return 1; }
      change_proposal_set_state "${new_cp}" CP_READY_FOR_VERIFICATION CP_DRAFT || return 1
      change_proposal_set_state "${new_cp}" CP_APPROVED CP_READY_FOR_VERIFICATION || return 1
      change_proposal_set_state "${new_cp}" CP_MERGED CP_APPROVED || return 1
      if [ -n "${pr_num}" ]; then
        change_proposal_set_pr_link "${new_cp}" "${pr_num}" || true
        it_pr_merge "${repo}" "${pr_num}" --squash >/dev/null \
          || log_warn "_caller_apply_qa_pkg/PASS: it_pr_merge failed (continuing)"
      fi
      # Release publish (application/release.sh — sourced by runner; not fatal if absent).
      if declare -F release_publish_from_milestone >/dev/null 2>&1; then
        release_publish_from_milestone "${repo}" "${ms_num}" "${env_path}" \
          || log_warn "_caller_apply_qa_pkg/PASS: release_publish_from_milestone failed"
      fi
      # Close child issues that are TASK_INTEGRATED.
      _caller_close_integrated_children "${repo}" "${ms_num}"
      it_milestone_set_state "${repo}" "${ms_num}" DONE VALIDATE_IN_PROGRESS \
        || { log_error "_caller_apply_qa_pkg/PASS: milestone VALIDATE_IN_PROGRESS→DONE failed"; return 1; }
      it_milestone_close "${repo}" "${ms_num}" \
        || log_warn "_caller_apply_qa_pkg/PASS: it_milestone_close failed"
      # KAC-CONTEXT-SUMMARY / KAC-DECISION-LOG: milestone DONE 시 누적 산출.
      if declare -F knowledge_snapshot_context_summary >/dev/null 2>&1; then
        local _qa_summary _qa_decision
        _qa_summary="$(jq -r '.artifacts.context_summary // .summary // empty' "${env_path}")"
        if [ -n "${_qa_summary}" ]; then
          knowledge_snapshot_context_summary "${target}" "${ms_num}" "${_qa_summary}" || true
        fi
        _qa_decision="$(jq -n \
          --arg decision_id "qa-pass-${ms_num}-${idem_key}" \
          --arg decision "Milestone #${ms_num} validated DONE" \
          --arg rationale "$(jq -r '.summary // empty' "${env_path}")" \
          --arg cp_path "${new_cp}" \
          --arg ms_id "${ms_num}" \
          '{decision_id: $decision_id, decision: $decision, rationale: $rationale, cp_path: $cp_path, affected_milestones: [$ms_id]}')"
        knowledge_record_decision "${target}" "${_qa_decision}" || true
      fi
      _caller_ledger_write "${target}" milestone "${ms_num}" VALIDATE_IN_PROGRESS DONE \
        "${operation}" "${idem_key}" "${manifest_id}" \
        ". + { outcome: \"PASS\", cp_kind: \"Milestone\", cp_path: \"${new_cp}\" }"
      ;;
    FAIL)
      if [ -n "${cp_path}" ]; then
        change_proposal_set_state "${cp_path}" CP_REQUEST_CHANGES \
          || log_warn "_caller_apply_qa_pkg/FAIL: CP →CP_REQUEST_CHANGES failed"
        change_proposal_set_state "${cp_path}" CP_CLOSED CP_REQUEST_CHANGES \
          || log_warn "_caller_apply_qa_pkg/FAIL: CP →CP_CLOSED failed"
      fi
      if [ -n "${pr_num}" ]; then
        it_pr_close "${repo}" "${pr_num}" \
          || log_warn "_caller_apply_qa_pkg/FAIL: it_pr_close failed"
      fi
      # Reset only the failing tasks back to TASK_READY.
      local failing
      failing="$(jq -r '.artifacts.failing_tasks[]? // empty' "${env_path}")"
      local issue_num
      while IFS= read -r issue_num; do
        [ -n "${issue_num}" ] || continue
        it_issue_set_state "${repo}" "${issue_num}" TASK_READY TASK_INTEGRATED \
          || log_warn "_caller_apply_qa_pkg/FAIL: cannot reset issue #${issue_num} to TASK_READY"
      done <<<"${failing}"
      it_milestone_set_state "${repo}" "${ms_num}" IMPLEMENTING VALIDATE_IN_PROGRESS \
        || { log_error "_caller_apply_qa_pkg/FAIL: milestone VALIDATE_IN_PROGRESS→IMPLEMENTING failed"; return 1; }
      _caller_ledger_write "${target}" milestone "${ms_num}" VALIDATE_IN_PROGRESS IMPLEMENTING \
        "${operation}" "${idem_key}" "${manifest_id}" \
        '. + { outcome: "FAIL", cp_kind: "Milestone" }'
      ;;
    STALE)
      if [ -n "${cp_path}" ]; then
        change_proposal_set_state "${cp_path}" CP_STALE \
          || log_warn "_caller_apply_qa_pkg/STALE: CP →CP_STALE failed"
      fi
      it_milestone_set_state "${repo}" "${ms_num}" VALIDATE_READY VALIDATE_IN_PROGRESS \
        || { log_error "_caller_apply_qa_pkg/STALE: milestone transition failed"; return 1; }
      _caller_ledger_write "${target}" milestone "${ms_num}" VALIDATE_IN_PROGRESS VALIDATE_READY \
        "${operation}" "${idem_key}" "${manifest_id}" \
        '. + { outcome: "STALE", cp_kind: "Milestone" }'
      ;;
    *)
      log_error "_caller_apply_qa_pkg: unknown outcome '${outcome}'"
      return 1
      ;;
  esac
}

# Close all TASK_INTEGRATED child issues of <ms_num> with a short note.
_caller_close_integrated_children() {
  local repo="$1" ms_num="$2"
  local issue_num
  while IFS= read -r issue_num; do
    [ -n "${issue_num}" ] || continue
    local their_ms
    their_ms="$(it_issue_get_milestone "${repo}" "${issue_num}" 2>/dev/null)"
    if [ "${their_ms}" = "${ms_num}" ]; then
      it_issue_close_with_note "${repo}" "${issue_num}" \
        "Closed by milestone #${ms_num} validation." || true
    fi
  done < <(it_issue_list_in_state "${repo}" TASK_INTEGRATED 2>/dev/null)
}

# ============================================================================
# Public: caller_advance_milestone_after_task_integrated
# ============================================================================

caller_advance_milestone_after_task_integrated() {
  local repo="$1" ms_num="$2"
  if [ -z "${repo}" ] || [ -z "${ms_num}" ]; then
    log_error "caller_advance_milestone_after_task_integrated: repo and ms_num are required"
    return 1
  fi
  # If any child task is in a non-INTEGRATED state, no-op.
  local non_integrated_states=(
    TASK_PENDING TASK_READY TASK_IN_PROGRESS
    TASK_REVIEW_READY TASK_REVIEW_IN_PROGRESS TASK_REJECTED
  )
  local s issue_num their_ms
  for s in "${non_integrated_states[@]}"; do
    while IFS= read -r issue_num; do
      [ -n "${issue_num}" ] || continue
      their_ms="$(it_issue_get_milestone "${repo}" "${issue_num}" 2>/dev/null)"
      if [ "${their_ms}" = "${ms_num}" ]; then
        log_info "caller_advance_milestone_after_task_integrated: ms #${ms_num} still has task #${issue_num} in ${s}; no-op"
        return 0
      fi
    done < <(it_issue_list_in_state "${repo}" "${s}" 2>/dev/null)
  done
  # All children integrated — advance milestone.
  local cur
  cur="$(it_milestone_get_state "${repo}" "${ms_num}" 2>/dev/null)"
  if [ "${cur}" != "IMPLEMENTING" ]; then
    log_info "caller_advance_milestone_after_task_integrated: ms #${ms_num} state '${cur}' (expected IMPLEMENTING); skipping"
    return 0
  fi
  it_milestone_set_state "${repo}" "${ms_num}" REFACTOR_READY IMPLEMENTING \
    || { log_error "caller_advance_milestone_after_task_integrated: milestone IMPLEMENTING→REFACTOR_READY failed"; return 1; }
  return 0
}
