#!/usr/bin/env bash
# application/agent_io.sh
#
# Agent 호출 입출력 보일러플레이트 모듈.
#
# 책임:
#   • agent_prompt_assemble  — prompts/<role>.md + manifest + envelope schema 합성
#   • agent_output_parse     — 단일 ```json fenced block 추출
#   • agent_output_validate_extended
#                           — agent_output_validate (lib/output.sh) + role↔kind +
#                             AGC-INVALID 6 invariant
#   • revision_pin_revalidate — envelope pin 들을 it_revision_pin_get 으로 재조회
#
# 호출 경계 (AGC-CALL-BOUNDARY):
#   • gh / git / curl / claude 직접 호출 금지.
#   • 외부 시스템과의 모든 상호작용은 lib/ports/* 의 it_* / lr_* 만 사용.
#   • 본 모듈은 기존 lib/output.sh / lib/context.sh / lib/roles.sh / lib/state.sh
#     의 함수를 재사용한다. 동일 로직 재구현 금지.

# ============================================================================
# Internal helpers
# ============================================================================

_agent_io_envelope_schema_section() {
  cat <<'__EOF__'
## Envelope Schema

산출물은 **단 하나의 ```json fenced block** 으로 출력한다 (그 외 텍스트는 무시).

필수 필드:
  • output_kind          (role 별 — po/pm=spec_proposal, planner=task_plan,
                          coder=patch, reviewer=verdict, integrator/qa=milestone_package)
  • agent_role           (PO/PM/Planner/Coder/Reviewer/Integrator/QA)
  • operation            (Compose-PO / Compose-PM / Decompose / Implement /
                          Review / Refactor / Validate)
  • object_id
  • manifest_id          (입력 Context Manifest id)
  • input_revision_pins  ([{object_kind, object_id, revision_pin}, ...] —
                          모든 object_id 는 manifest entries 안에 있어야 한다)
  • idempotency_key
  • summary
  • artifacts            (역할별 자유 영역 — worktree 내부 path 만 허용)

금지:
  • merge / close_issue / set_label / notify / lease_expire 등 운영 동사 키
  • envelope 내 비밀/자격증명 (ghp_, Bearer, password=, BEGIN ...PRIVATE KEY)
  • manifest 외 객체 참조
  • 할당된 worktree 외부 파일 path (절대경로 / `..` traversal)
__EOF__
}

# Locate the manifest file by manifest_id under workdir/<target>/manifests/.
# stdout: matching path (single result expected). Non-zero if not found.
_agent_io_manifest_path_by_id() {
  local manifest_id="$1"
  if [ -z "${manifest_id}" ] || [ -z "${LLM_TEAM_ROOT:-}" ]; then
    return 1
  fi
  local match
  # Use bash glob (nullglob) for safety.
  shopt -s nullglob
  local matches=( "${LLM_TEAM_ROOT}/workdir/"*"/manifests/${manifest_id}.json" )
  shopt -u nullglob
  if [ "${#matches[@]}" -eq 0 ]; then
    return 1
  fi
  if [ "${#matches[@]}" -gt 1 ]; then
    log_error "_agent_io_manifest_path_by_id: multiple manifests share id '${manifest_id}'"
    return 1
  fi
  printf '%s' "${matches[0]}"
}

# Read first ```json … ``` fenced block from input. stdout: JSON content.
# Fails if 0 or >1 blocks.
_agent_io_extract_fenced_json() {
  local content="$1"
  # awk-based fenced-block extractor: collect blocks between '```json' and '```'.
  local blocks
  blocks="$(printf '%s\n' "${content}" | awk '
    BEGIN { in_block = 0; count = 0 }
    /^[[:space:]]*```json[[:space:]]*$/ {
      if (in_block) { exit 2 }
      in_block = 1
      count += 1
      printf "===BLOCK===\n"
      next
    }
    /^[[:space:]]*```[[:space:]]*$/ {
      if (in_block) {
        in_block = 0
        printf "===END===\n"
      }
      next
    }
    { if (in_block) print }
    END { if (count == 0) exit 3 }
  ')" || {
    local rc=$?
    case "${rc}" in
      2) log_error "agent_output_parse: nested fenced block detected"; return 1 ;;
      3) log_error "agent_output_parse: no \`\`\`json fenced block found"; return 1 ;;
      *) log_error "agent_output_parse: awk extraction failed (rc=${rc})"; return 1 ;;
    esac
  }
  # Count blocks.
  local n
  n="$(printf '%s' "${blocks}" | grep -c '^===BLOCK===$')"
  if [ "${n}" -gt 1 ]; then
    log_error "agent_output_parse: multiple fenced blocks (found ${n})"
    return 1
  fi
  # Strip markers.
  local json
  json="$(printf '%s\n' "${blocks}" | sed -e '/^===BLOCK===$/d' -e '/^===END===$/d')"
  # Validate JSON.
  if ! printf '%s' "${json}" | jq -e '.' >/dev/null 2>&1; then
    log_error "agent_output_parse: fenced block is not valid JSON"
    return 1
  fi
  printf '%s' "${json}"
}

# ============================================================================
# Public: agent_prompt_assemble
# ============================================================================

# agent_prompt_assemble <role> <manifest_path> [extra_instruction]
#
# Returns the assembled prompt on stdout. Pure transform — no side effects.
# • prompts/<role>.md 의 head `__MANIFEST_ID__` 를 manifest_id 로 sed 치환.
# • '## Manifest' + manifest JSON 본문 append.
# • '## Envelope Schema' + 리터럴 schema 안내 append.
# • extra_instruction 이 주어지면 '## Caller Notes' 로 그 뒤에 append.
#
# Coupling: prompts/<role>.md 의 첫 3 줄 헤더(`# Role:` / `# Operation:` /
# `# Manifest-id:`) 는 lib/roles.sh `role_normalize` / `role_operation` 의
# canonical form 과 1:1 일치해야 한다. 불일치 시 `lr_call` (lib/ports/llm_runner.sh)
# 의 header consistency check 가 호출 직전에 `adapter_unavailable` 로 차단한다.
# prompt template 추가/수정 시 lib/roles.sh 매핑과의 일치성 점검이 필수.
agent_prompt_assemble() {
  local role="$1" manifest_path="$2" extra_instruction="${3:-}"
  if [ -z "${role}" ] || [ -z "${manifest_path}" ]; then
    log_error "agent_prompt_assemble: role and manifest_path are required"
    return 1
  fi
  if [ ! -f "${manifest_path}" ]; then
    log_error "agent_prompt_assemble: manifest not found: ${manifest_path}"
    return 1
  fi
  local prompt_path manifest_id prompt_body manifest_body
  prompt_path="$(role_prompt_path "${role}")" || {
    log_error "agent_prompt_assemble: invalid role '${role}'"
    return 1
  }
  if [ ! -f "${prompt_path}" ]; then
    log_error "agent_prompt_assemble: prompt missing: ${prompt_path}"
    return 1
  fi
  manifest_id="$(context_manifest_id "${manifest_path}")" || {
    log_error "agent_prompt_assemble: cannot read manifest_id from ${manifest_path}"
    return 1
  }
  if [ -z "${manifest_id}" ] || [ "${manifest_id}" = "null" ]; then
    log_error "agent_prompt_assemble: manifest_id missing in ${manifest_path}"
    return 1
  fi
  # Substitute placeholder. Use awk so '/' in id does not break sed.
  prompt_body="$(awk -v mid="${manifest_id}" '{ gsub(/__MANIFEST_ID__/, mid); print }' "${prompt_path}")"
  manifest_body="$(jq '.' "${manifest_path}")" || {
    log_error "agent_prompt_assemble: cannot serialize manifest"
    return 1
  }
  printf '%s\n\n## Manifest\n```json\n%s\n```\n\n' \
    "${prompt_body}" "${manifest_body}"
  _agent_io_envelope_schema_section
  if [ -n "${extra_instruction}" ]; then
    printf '\n\n## Caller Notes\n%s\n' "${extra_instruction}"
  fi
}

# ============================================================================
# Public: agent_output_parse
# ============================================================================

# agent_output_parse <stdout_path_or_string>
# stdout: the JSON string inside the single ```json fenced block.
# Fail (non-zero) if 0 / >1 blocks, or if JSON is invalid.
agent_output_parse() {
  local arg="$1"
  if [ -z "${arg}" ]; then
    log_error "agent_output_parse: input (path or string) is required"
    return 1
  fi
  local content
  if [ -f "${arg}" ]; then
    content="$(cat "${arg}")"
  else
    content="${arg}"
  fi
  _agent_io_extract_fenced_json "${content}"
}

# ============================================================================
# Public: agent_output_validate_extended
# ============================================================================

# agent_output_validate_extended <envelope_json_or_path> <role>
#
# Runs the Phase-1 baseline checks (lib/output.sh agent_output_validate) plus the
# AGC-INVALID 6 invariants:
#   a. manifest 외 객체 참조 — input_revision_pins[].object_id ⊆ manifest entries
#   b. 필수 필드 누락 (baseline)
#   c. revision pin 누락 (baseline: input_revision_pins 배열 형식)
#   d. operational side-effect 텍스트 (baseline grep)
#   e. 비밀/자격증명 포함 — ghp_ / Bearer  / password= / BEGIN …PRIVATE KEY
#   f. 할당 범위 밖 파일 변경 — patch envelope 의 artifacts 안 path 가 worktree
#                                 내부여야 (절대경로 / `..` traversal 거부)
agent_output_validate_extended() {
  local envelope_arg="$1" role="$2"
  if [ -z "${envelope_arg}" ] || [ -z "${role}" ]; then
    log_error "agent_output_validate_extended: envelope and role are required"
    return 1
  fi
  local normalized_role
  normalized_role="$(role_normalize "${role}")" || {
    log_error "agent_output_validate_extended: invalid role '${role}'"
    return 1
  }
  local expected_operation expected_kind
  expected_operation="$(role_operation "${normalized_role}")"
  expected_kind="$(role_output_kind "${normalized_role}")"

  # Materialize envelope to a temp file so jq -e can read it.
  local envelope_file cleanup_envelope=0
  if [ -f "${envelope_arg}" ]; then
    envelope_file="${envelope_arg}"
  else
    envelope_file="$(mktemp -t llm-team-envelope.XXXXXX)" || {
      log_error "agent_output_validate_extended: mktemp failed"
      return 1
    }
    cleanup_envelope=1
    printf '%s' "${envelope_arg}" >"${envelope_file}"
  fi
  _agent_io_cleanup_envelope_file() {
    [ "${cleanup_envelope}" -eq 1 ] && rm -f "${envelope_file}" 2>/dev/null || true
  }

  # Validate JSON parses first.
  if ! jq -e '.' "${envelope_file}" >/dev/null 2>&1; then
    log_error "agent_output_validate_extended: envelope is not valid JSON"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  local manifest_id
  manifest_id="$(jq -r '.manifest_id // empty' "${envelope_file}")"
  if [ -z "${manifest_id}" ]; then
    log_error "agent_output_validate_extended: envelope.manifest_id missing"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- baseline -----
  if ! agent_output_validate "${envelope_file}" "${normalized_role}" "${expected_operation}" "${manifest_id}"; then
    log_error "agent_output_validate_extended: baseline validate failed"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- role × output_kind explicit re-check -----
  local actual_kind
  actual_kind="$(jq -r '.output_kind' "${envelope_file}")"
  if [ "${actual_kind}" != "${expected_kind}" ] && [ "${actual_kind}" != "failure" ]; then
    log_error "agent_output_validate_extended: output_kind '${actual_kind}' does not match role '${normalized_role}' (expected '${expected_kind}')"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- (a) manifest 외 객체 참조 -----
  local manifest_path
  manifest_path="$(_agent_io_manifest_path_by_id "${manifest_id}")" || {
    log_error "agent_output_validate_extended: manifest not found for id '${manifest_id}'"
    _agent_io_cleanup_envelope_file
    return 1
  }
  if ! jq -e --slurpfile mf "${manifest_path}" '
        ($mf[0].entries // []) as $entries
        | (.input_revision_pins // []) as $pins
        | ($pins | map(.object_id // "") | map(select(length > 0))) as $pin_ids
        | ($entries | map(.object_id)) as $entry_ids
        | ($pin_ids - $entry_ids) | length == 0
      ' "${envelope_file}" >/dev/null 2>&1; then
    log_error "agent_output_validate_extended: input_revision_pins reference object_id outside manifest"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- (b) code_tree required entry must appear in input_revision_pins -----
  # When runner injects code_tree as required, agent MUST include it in its
  # output pins so revision_pin_revalidate can verify the RO tree snapshot.
  if ! jq -e --slurpfile mf "${manifest_path}" '
        ($mf[0].entries // []) as $entries
        | (.input_revision_pins // []) as $pins
        | ($pins | map(.object_id // "") | map(select(length > 0))) as $pin_ids
        | [$entries[] | select(.object_kind == "code_tree" and .required == true) | .object_id] as $code_tree_required
        | ($code_tree_required - $pin_ids) | length == 0
      ' "${envelope_file}" >/dev/null 2>&1; then
    log_error "agent_output_validate_extended: required code_tree entry missing from input_revision_pins"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- (e) 비밀/자격증명 포함 -----
  if grep -qE '(ghp_[A-Za-z0-9]+|Bearer [A-Za-z0-9._\-]+|password=|-----BEGIN [A-Z ]*PRIVATE KEY-----)' "${envelope_file}"; then
    log_error "agent_output_validate_extended: envelope contains secret/credential pattern"
    _agent_io_cleanup_envelope_file
    return 1
  fi

  # ----- (f) 할당 범위 밖 파일 변경 (patch envelope 한정) -----
  if [ "${actual_kind}" = "patch" ]; then
    if ! _agent_io_check_patch_paths "${envelope_file}"; then
      _agent_io_cleanup_envelope_file
      return 1
    fi
  fi

  # ----- (g) KAC-TRACEABILITY (P1-6): AC-ID 추적 게이트 -----
  # Planner Decompose: ac_id_to_task 가 있어야 하고 매핑된 task slug 가 모두
  # artifacts.tasks[].slug 에 존재해야 한다(Decompose FAIL).
  # QA Validate(PASS|FAIL): ac_results 가 비어있지 않아야 하고 각 항목이
  # {ac_id, verdict ∈ {PASS,FAIL}, responsible_task_ids[]} 구조여야 한다(Validate FAIL).
  if ! _agent_io_check_ac_traceability "${envelope_file}" "${normalized_role}" "${actual_kind}"; then
    _agent_io_cleanup_envelope_file
    return 1
  fi

  _agent_io_cleanup_envelope_file
  return 0
}

# Helper: enforce KAC-TRACEABILITY for Planner output and QA milestone_package.
# Returns 0 if check passes (or N/A for this role/kind), 1 with stderr on FAIL.
_agent_io_check_ac_traceability() {
  local envelope_file="$1" role="$2" kind="$3"
  case "${role}-${kind}" in
    Planner-task_plan)
      # ac_id_to_task: object {AC-* : [task_slug, ...]}; tasks[]: [{slug, ...}].
      jq -e '
        (.artifacts.ac_id_to_task // null) as $map
        | (.artifacts.tasks // []) as $tasks
        | ($tasks | map(.slug // "") | map(select(length > 0))) as $slugs
        | ($map != null) and ($map | type == "object") and ($map | length > 0)
          and (
            [ $map | to_entries[] | .value | type == "array" and length > 0 ]
            | all
          )
          and (
            [ $map | to_entries[] | .value[] | . as $s | $slugs | index($s) != null ]
            | all
          )
      ' "${envelope_file}" >/dev/null 2>&1 || {
        log_error "agent_output_validate_extended: KAC-TRACEABILITY (P1-6) Planner ac_id_to_task missing or maps unknown task slugs"
        return 1
      }
      ;;
    QA-milestone_package)
      # ac_results required only for terminal verdicts (PASS/FAIL); STALE/NO-OP
      # outcomes can occur before full validation completes.
      local outcome
      outcome="$(jq -r '.artifacts.outcome // empty' "${envelope_file}")"
      case "${outcome}" in
        PASS|FAIL)
          jq -e '
            (.artifacts.ac_results // []) as $r
            | ($r | type == "array" and length > 0)
              and (
                [ $r[]
                  | (.ac_id | type == "string" and length > 0)
                    and (.verdict | IN("PASS","FAIL"))
                    and (.responsible_task_ids | type == "array")
                ] | all
              )
          ' "${envelope_file}" >/dev/null 2>&1 || {
            log_error "agent_output_validate_extended: KAC-TRACEABILITY (P1-6) QA ac_results missing or malformed"
            return 1
          }
          ;;
      esac
      ;;
  esac
  return 0
}

# Helper: scan patch-envelope artifacts for paths escaping the worktree.
# Strategy:
#   1. Collect explicit `.artifacts.patch_diff` (string) and parse `--- a/<p>`,
#      `+++ b/<p>`, `diff --git a/<p> b/<q>` paths.
#   2. Collect any `.path` strings under `.artifacts | recurse`.
#   3. Reject if any candidate path is absolute (starts with `/`) or contains
#      `../` segment, or starts with `..`.
_agent_io_check_patch_paths() {
  local envelope_file="$1"
  local diff_text candidate_paths
  diff_text="$(jq -r '.artifacts.patch_diff // empty' "${envelope_file}" 2>/dev/null)"
  candidate_paths=""
  if [ -n "${diff_text}" ]; then
    # Extract paths from common diff headers.
    candidate_paths="$(printf '%s\n' "${diff_text}" \
      | awk '
          /^diff --git / { for (i=3;i<=NF;i++) { sub(/^a\//,"",$i); sub(/^b\//,"",$i); print $i } }
          /^--- /        { p=$2; sub(/^a\//,"",p); print p }
          /^\+\+\+ /     { p=$2; sub(/^b\//,"",p); print p }
        ' \
      | sort -u)"
  fi
  # Structured paths: any string under `.artifacts | .. | objects | .path`.
  local struct_paths
  struct_paths="$(jq -r '
      [.artifacts? | .. | objects | .path? // empty]
      | unique
      | .[]
    ' "${envelope_file}" 2>/dev/null || true)"
  # Combine.
  local all_paths
  all_paths="$(printf '%s\n%s\n' "${candidate_paths}" "${struct_paths}" \
    | grep -v '^$' \
    | grep -vE '^/dev/null$' \
    | sort -u)"
  if [ -z "${all_paths}" ]; then
    return 0
  fi
  local p
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    case "${p}" in
      /*)
        log_error "agent_output_validate_extended: patch path is absolute: '${p}'"
        return 1
        ;;
      *..*)
        # Reject if any path segment is '..' (parent traversal).
        if printf '%s' "${p}" | awk -F/ '{ for (i=1;i<=NF;i++) if ($i=="..") exit 1; exit 0 }'; then
          : # no ..; allowed
        else
          log_error "agent_output_validate_extended: patch path escapes worktree: '${p}'"
          return 1
        fi
        ;;
    esac
  done <<<"${all_paths}"
  return 0
}

# ============================================================================
# Public: revision_pin_revalidate
# ============================================================================

# revision_pin_revalidate <envelope_json_or_path> <repo>
# Returns 0 if every input_revision_pins[] still matches the live revision_pin
# from it_revision_pin_get; returns 1 if any pin is stale (with details on stderr).
revision_pin_revalidate() {
  local envelope_arg="$1" repo="$2"
  if [ -z "${envelope_arg}" ] || [ -z "${repo}" ]; then
    log_error "revision_pin_revalidate: envelope and repo are required"
    return 1
  fi
  local envelope_file cleanup_file=0
  if [ -f "${envelope_arg}" ]; then
    envelope_file="${envelope_arg}"
  else
    envelope_file="$(mktemp -t llm-team-revalidate.XXXXXX)" || {
      log_error "revision_pin_revalidate: mktemp failed"
      return 1
    }
    cleanup_file=1
    printf '%s' "${envelope_arg}" >"${envelope_file}"
  fi
  _cleanup() { [ "${cleanup_file}" -eq 1 ] && rm -f "${envelope_file}" 2>/dev/null || true; }

  local stale=0 expected_pins
  expected_pins="$(jq -c '.input_revision_pins[]?' "${envelope_file}" 2>/dev/null)" || {
    log_error "revision_pin_revalidate: cannot read input_revision_pins"
    _cleanup
    return 1
  }
  if [ -z "${expected_pins}" ]; then
    _cleanup
    return 0
  fi
  while IFS= read -r pin; do
    [ -n "${pin}" ] || continue
    local kind id expected actual
    kind="$(printf '%s' "${pin}" | jq -r '.object_kind // empty')"
    id="$(printf '%s' "${pin}" | jq -r '.object_id // empty')"
    expected="$(printf '%s' "${pin}" | jq -r '.revision_pin // empty')"
    if [ -z "${kind}" ] || [ -z "${id}" ]; then
      log_error "revision_pin_revalidate: pin missing object_kind or object_id: ${pin}"
      stale=1
      continue
    fi
    # code_tree: compare against current RO tree pin (not live branch HEAD).
    # The expected pin is the SHA at RO mount time; ws_ro_tree_revision_pin
    # returns the current pinned SHA. If they differ, the RO tree was
    # refreshed mid-cycle and agent output may not be grounded in the
    # snapshot it actually saw.
    if [ "${kind}" = "code_tree" ]; then
      if [ "${id}" != "${repo}" ]; then
        log_error "revision_pin_revalidate: code_tree object_id '${id}' does not match repo '${repo}'"
        stale=1
        continue
      fi
      if [ -z "${TARGET_NAME:-}" ]; then
        log_error "revision_pin_revalidate: TARGET_NAME required for code_tree pin lookup"
        stale=1
        continue
      fi
      if ! actual="$(ws_ro_tree_revision_pin "${TARGET_NAME}" 2>/dev/null)"; then
        log_error "revision_pin_revalidate: code_tree ${id} RO tree pin lookup failed"
        stale=1
        continue
      fi
    else
      if ! actual="$(it_revision_pin_get "${repo}" "${kind}" "${id}" 2>/dev/null)"; then
        log_error "revision_pin_revalidate: cannot fetch live pin for ${kind}#${id}"
        stale=1
        continue
      fi
    fi
    if [ "${actual}" != "${expected}" ]; then
      log_error "revision_pin_revalidate: stale pin — ${kind}#${id}: expected='${expected}' actual='${actual}'"
      stale=1
    fi
  done <<<"${expected_pins}"

  _cleanup
  if [ "${stale}" -ne 0 ]; then
    return 1
  fi
  return 0
}
