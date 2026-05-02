#!/usr/bin/env bash
# application/onboarding/checklists/github_pipeline_v1.sh
#
# Onboarding checklist preset: github-pipeline/v1.
#
# Source: .human/draft/github-pipeline-onboarding.md
#
# preset_items: TSV (id\tkind\tseverity\tself_hosting_only\tauto_fn\tack_key\tsummary)
# _check_<id>:  PASS=exit 0 (메시지를 stdout). FAIL=non-zero (실패 사유 stdout).
# preset_remediation <id>: FAIL 시 안내 1 줄.

# Contract 라벨 이름은 lib/labels.sh 가 단일 출처. 중복 정의 방지.
if [ -z "${LLM_TEAM_LABELS_LOADED:-}" ]; then
  # shellcheck source=../../../lib/labels.sh
  . "${LLM_TEAM_ROOT}/lib/labels.sh"
  LLM_TEAM_LABELS_LOADED=1
fi

# preset_items 가 TSV 를 emit. 칼럼은 항상 7 개. 빈 칼럼은 '-' 로 표기 (engine 이
# '-' 를 빈 문자열로 변환). bash read 는 IFS=$'\t' 에서도 공백류 IFS 의 연속을
# 한 delimiter 로 collapse 하므로 빈 칼럼을 그대로 두면 칼럼이 밀린다.
preset_items() {
  cat <<'EOF'
github_repo_reachable	auto	block	0	_check_github_repo_reachable	-	gh api repos/{owner}/{repo}
gh_token_scopes_sufficient	auto	block	0	_check_gh_token_scopes	-	gh token scope (repo)
gh_token_workflow_scope	ack	warn	0	-	gh_token_workflow_scope	gh token has workflow scope
canonical_clone_present	auto	block	0	_check_canonical_clone	-	canonical clone is a git repo
no_clone_path_collision	auto	block	0	_check_no_clone_path_collision	-	clone_path uniqueness across targets
target_init_scaffold	auto	block	0	_check_target_init_scaffold	-	workdir scaffold + agent-cwd
doctor_dependencies	auto	block	0	_check_doctor_dependencies	-	bash/jq/yq/git/gh/claude available
daemon_lockdir_writable	auto	block	0	_check_daemon_lockdir_writable	-	workdir writable
labels_bootstrap_done	auto	block	0	_check_labels_bootstrap_done	-	contract labels exist on repo
integration_branch_present	auto_or_ack	block	0	_check_integration_branch	use_default_branch_as_integration	integration branch exists on origin
branch_protection_policy_decided	ack	block	0	-	branch_protection_policy_decided	push/review policy on main/integration decided
notifier_channel_decided	auto_or_ack	block	0	_check_notifier_channel	intentionally_silent	notifier.channel set or silent ack
inputs_dir_seeded	auto_or_ack	warn	0	_check_inputs_dir_seeded	use_github_issues_only	inputs/<target>/ has at least one file or ack
dev_concurrency_reviewed	ack	warn	0	-	dev_concurrency_reviewed	dev_concurrency value reviewed
amendment_policy_acknowledged	ack	block	1	-	amendment_policy_acknowledged	self-hosting amendment gate policy acked
ci_workflow_loop_guard	auto_or_ack	block	1	_check_ci_workflow_loop_guard	ci_workflow_loop_guard_decided	self-hosting CI loop guard
EOF
}

preset_remediation() {
  local id="$1"
  case "${id}" in
    github_repo_reachable)
      printf 'gh auth status / gh auth login, 또는 target.github.{owner,repo} 확인'
      ;;
    gh_token_scopes_sufficient)
      printf "gh auth refresh -h github.com -s repo  (또는 'gh auth login --scopes repo')"
      ;;
    gh_token_workflow_scope)
      printf 'gh auth refresh -h github.com -s workflow  (워크플로우 자동화 시)'
      ;;
    canonical_clone_present)
      printf 'llm-team target init %s  (또는 local.clone_path 를 git repo 로)' "${TARGET_NAME}"
      ;;
    no_clone_path_collision)
      printf '다른 target.yaml 과 local.clone_path 가 같음 — 한쪽을 비우거나 다른 경로로 변경'
      ;;
    target_init_scaffold)
      printf 'llm-team target init %s' "${TARGET_NAME}"
      ;;
    doctor_dependencies)
      printf 'llm-team doctor — 누락 도구 설치 (bash, jq, yq, git, gh, claude)'
      ;;
    daemon_lockdir_writable)
      printf 'chmod u+w %s/workdir' "${LLM_TEAM_ROOT}"
      ;;
    labels_bootstrap_done)
      printf 'llm-team labels bootstrap %s' "${TARGET_NAME}"
      ;;
    integration_branch_present)
      local br="${LLM_TEAM_INTEGRATION_BRANCH:-integration}"
      printf 'git push origin %s:%s  (또는 llm-team onboarding ack %s use_default_branch_as_integration)' \
        "${TARGET_DEFAULT_BRANCH:-main}" "${br}" "${TARGET_NAME}"
      ;;
    branch_protection_policy_decided)
      printf 'llm-team onboarding ack %s branch_protection_policy_decided --note "..."' "${TARGET_NAME}"
      ;;
    notifier_channel_decided)
      printf 'target.yaml notifier.channel 설정 (discord/slack), 또는 llm-team onboarding ack %s intentionally_silent' "${TARGET_NAME}"
      ;;
    inputs_dir_seeded)
      printf 'inputs/%s/ 에 첫 입력 추가, 또는 llm-team onboarding ack %s use_github_issues_only' \
        "${TARGET_NAME}" "${TARGET_NAME}"
      ;;
    dev_concurrency_reviewed)
      printf 'llm-team onboarding ack %s dev_concurrency_reviewed' "${TARGET_NAME}"
      ;;
    amendment_policy_acknowledged)
      printf 'llm-team onboarding ack %s amendment_policy_acknowledged --note "..."' "${TARGET_NAME}"
      ;;
    ci_workflow_loop_guard)
      printf '.github/workflows/ trigger 정책 결정 후 llm-team onboarding ack %s ci_workflow_loop_guard_decided' \
        "${TARGET_NAME}"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# auto check 함수들
# 규칙:
#  - PASS: stdout 에 짧은 사실 (예: "bakpark/llm-team"), exit 0.
#  - FAIL: stdout 에 짧은 사유, exit 1.
#  - 외부 명령(gh/git) 미설치 시 FAIL (사유 명시) — doctor_dependencies 항목이 별도 가드.
# ---------------------------------------------------------------------------

_check_github_repo_reachable() {
  if ! command -v gh >/dev/null 2>&1; then
    printf 'gh not installed'; return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  if gh api "repos/${repo}" >/dev/null 2>&1; then
    printf '%s' "${repo}"
    return 0
  fi
  printf 'gh api repos/%s failed (auth or repo missing)' "${repo}"
  return 1
}

_check_gh_token_scopes() {
  if ! command -v gh >/dev/null 2>&1; then
    printf 'gh not installed'; return 1
  fi
  local out
  out="$(gh auth status 2>&1)" || { printf 'gh not authenticated'; return 1; }
  if printf '%s' "${out}" | grep -Eq "scopes:.*['\"]?repo['\"]?"; then
    printf 'repo scope present'
    return 0
  fi
  printf 'token missing repo scope'
  return 1
}

_check_canonical_clone() {
  local path="${TARGET_CLONE_PATH}"
  [ -n "${path}" ] || path="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/repo"
  if [ -d "${path}/.git" ] || [ -f "${path}/.git" ]; then
    printf '%s' "${path}"
    return 0
  fi
  printf '%s is not a git repo' "${path}"
  return 1
}

_check_no_clone_path_collision() {
  local self="${LLM_TEAM_ROOT}/targets/${TARGET_NAME}.yaml"
  local self_path="${TARGET_CLONE_PATH}"
  [ -n "${self_path}" ] || self_path="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/repo"
  local f other_name other_path resolved
  for f in "${LLM_TEAM_ROOT}/targets"/*.yaml; do
    [ -f "${f}" ] || continue
    [ "${f}" = "${self}" ] && continue
    other_name="$(yq -r '.name // ""' "${f}" 2>/dev/null)"
    [ -n "${other_name}" ] || other_name="$(basename "${f}" .yaml)"
    other_path="$(yq -r '.local.clone_path // ""' "${f}" 2>/dev/null)"
    if [ -z "${other_path}" ]; then
      resolved="${LLM_TEAM_ROOT}/workdir/${other_name}/repo"
    else
      resolved="${other_path}"
      case "${resolved}" in "~"*) resolved="${HOME}${resolved#\~}" ;; esac
    fi
    if [ "${resolved}" = "${self_path}" ]; then
      printf 'collision with target %s (%s)' "${other_name}" "${resolved}"
      return 1
    fi
  done
  printf 'unique'
  return 0
}

_check_target_init_scaffold() {
  local workdir="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}"
  local missing="" d
  for d in manifests leases ledger wt change-proposals; do
    [ -d "${workdir}/${d}" ] || missing="${missing} ${d}"
  done
  for d in po pm planner; do
    [ -d "${workdir}/agent-cwd/${d}" ] || missing="${missing} agent-cwd/${d}"
  done
  if [ -n "${missing}" ]; then
    printf 'missing:%s' "${missing}"
    return 1
  fi
  printf 'scaffold ok'
  return 0
}

_check_doctor_dependencies() {
  local missing="" cmd
  for cmd in bash jq yq git gh claude; do
    command -v "${cmd}" >/dev/null 2>&1 || missing="${missing} ${cmd}"
  done
  if [ -n "${missing}" ]; then
    printf 'missing:%s' "${missing}"
    return 1
  fi
  printf 'all present'
  return 0
}

_check_daemon_lockdir_writable() {
  local d="${LLM_TEAM_ROOT}/workdir"
  if mkdir -p "${d}" >/dev/null 2>&1 && [ -w "${d}" ]; then
    printf '%s writable' "${d}"
    return 0
  fi
  printf '%s not writable' "${d}"
  return 1
}

_check_labels_bootstrap_done() {
  if ! command -v gh >/dev/null 2>&1; then
    printf 'gh not installed'; return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local prefix="${TARGET_LABEL_PREFIX:-}"
  local probes=(
    "${LABEL_TASK_READY}"
    "${LABEL_CP_READY_FOR_REVIEW}"
    "${LABEL_HUMAN_GATE_PO}"
    "${LABEL_PAUSED}"
    "${LABEL_FEATURE_REQUEST}"
  )
  local missing="" l name
  for l in "${probes[@]}"; do
    name="${prefix}${l}"
    if ! gh label list --repo "${repo}" --search "${name}" --json name 2>/dev/null \
        | grep -Fq "\"${name}\""; then
      missing="${missing} ${name}"
    fi
  done
  if [ -n "${missing}" ]; then
    printf 'missing:%s' "${missing}"
    return 1
  fi
  printf 'present'
  return 0
}

_check_integration_branch() {
  if ! command -v gh >/dev/null 2>&1; then
    printf 'gh not installed'; return 1
  fi
  local repo="${TARGET_GH_OWNER}/${TARGET_GH_REPO}"
  local br="${LLM_TEAM_INTEGRATION_BRANCH:-integration}"
  if gh api "repos/${repo}/branches/${br}" >/dev/null 2>&1; then
    printf "branch '%s' exists" "${br}"
    return 0
  fi
  printf "branch '%s' missing on origin" "${br}"
  return 1
}

_check_notifier_channel() {
  local ch="${TARGET_NOTIFIER_CHANNEL:-none}"
  if [ "${ch}" = "none" ] || [ -z "${ch}" ]; then
    printf 'notifier.channel = none'
    return 1
  fi
  printf 'notifier.channel = %s' "${ch}"
  return 0
}

_check_inputs_dir_seeded() {
  local dir="${LLM_TEAM_ROOT}/${TARGET_INPUTS_DIR:-inputs/${TARGET_NAME}}"
  [ -d "${dir}" ] || { printf '%s missing' "${dir}"; return 1; }
  local found
  found="$(find "${dir}" -type f \
    ! -name '.gitkeep' ! -name '.keep' \
    ! -empty 2>/dev/null | head -n 1)"
  if [ -n "${found}" ]; then
    printf '%s has content' "${dir}"
    return 0
  fi
  printf '%s contains only placeholders/empty files' "${dir}"
  return 1
}

_check_ci_workflow_loop_guard() {
  local clone="${TARGET_CLONE_PATH}"
  [ -n "${clone}" ] || clone="${LLM_TEAM_ROOT}/workdir/${TARGET_NAME}/repo"
  local wf="${clone}/.github/workflows"
  if [ ! -d "${wf}" ]; then
    printf 'no .github/workflows present'
    return 0
  fi
  if [ -z "$(ls -A "${wf}" 2>/dev/null || true)" ]; then
    printf '.github/workflows is empty'
    return 0
  fi
  # 위험 트리거: pull_request_target / workflow_run / repository_dispatch.
  # 0 건이면 자동 PASS, 1+ 면 ack 강제. yaml 풀 파싱은 별도 PR 보류 — 현 구현은
  # `on: <trigger>:` 또는 `on:` 매핑 키 위치의 라인을 grep 으로 휴리스틱 매칭.
  if grep -REq '^[[:space:]]*(pull_request_target|workflow_run|repository_dispatch)[[:space:]]*:' \
       "${wf}" 2>/dev/null; then
    printf 'workflows contain risky triggers — loop guard ack required'
    return 1
  fi
  printf 'workflows have only safe triggers'
  return 0
}
