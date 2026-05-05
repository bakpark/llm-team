#!/usr/bin/env bash
# Install the repo-local llm-team CLI into a user-writable bin directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_TEAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_PATH="${LLM_TEAM_ROOT}/bin/llm-team"

BIN_DIR="${HOME}/.local/bin"
COMMAND_NAME="llm-team"
FORCE=0
DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --bin-dir DIR     Install symlink into DIR (default: ~/.local/bin)
  --name NAME       Command name to create (default: llm-team)
  --force           Replace an existing command at the destination
  --dry-run         Print actions without changing files
  --uninstall       Remove the installed command if it points to this checkout
  -h, --help        Show this help

Examples:
  scripts/install-cli.sh
  scripts/install-cli.sh --bin-dir /tmp/bin --name llm-team-dev
  scripts/install-cli.sh --uninstall
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      BIN_DIR="${2:-}"
      [ -n "${BIN_DIR}" ] || die "--bin-dir requires a value"
      shift 2
      ;;
    --name)
      COMMAND_NAME="${2:-}"
      [ -n "${COMMAND_NAME}" ] || die "--name requires a value"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "${COMMAND_NAME}" in
  */*|'') die "--name must be a command name, not a path" ;;
esac

[ -x "${CLI_PATH}" ] || die "CLI entrypoint is not executable: ${CLI_PATH}"

case "${BIN_DIR}" in
  "~"*) BIN_DIR="${HOME}${BIN_DIR#\~}" ;;
esac

LINK_PATH="${BIN_DIR}/${COMMAND_NAME}"

existing_target() {
  if [ -L "${LINK_PATH}" ]; then
    readlink "${LINK_PATH}"
  else
    printf ''
  fi
}

path_in_path() {
  local dir="$1" part
  IFS=':' read -r -a parts <<<"${PATH:-}"
  for part in "${parts[@]}"; do
    [ "${part}" = "${dir}" ] && return 0
  done
  return 1
}

if [ "${UNINSTALL}" -eq 1 ]; then
  if [ ! -e "${LINK_PATH}" ] && [ ! -L "${LINK_PATH}" ]; then
    info "No installed command at ${LINK_PATH}"
    exit 0
  fi
  if [ -L "${LINK_PATH}" ] && [ "$(existing_target)" = "${CLI_PATH}" ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
      info "Would remove ${LINK_PATH}"
    else
      rm -f "${LINK_PATH}"
      info "Removed ${LINK_PATH}"
    fi
    exit 0
  fi
  die "refusing to remove ${LINK_PATH}; it does not point to ${CLI_PATH}"
fi

if [ -e "${LINK_PATH}" ] || [ -L "${LINK_PATH}" ]; then
  if [ -L "${LINK_PATH}" ] && [ "$(existing_target)" = "${CLI_PATH}" ]; then
    info "Already installed: ${LINK_PATH} -> ${CLI_PATH}"
  elif [ "${FORCE}" -eq 1 ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
      info "Would replace ${LINK_PATH} with symlink to ${CLI_PATH}"
    else
      rm -f "${LINK_PATH}"
      mkdir -p "${BIN_DIR}"
      ln -s "${CLI_PATH}" "${LINK_PATH}"
      info "Installed ${LINK_PATH} -> ${CLI_PATH}"
    fi
  else
    die "${LINK_PATH} already exists; use --force to replace it"
  fi
else
  if [ "${DRY_RUN}" -eq 1 ]; then
    info "Would create ${BIN_DIR}"
    info "Would install ${LINK_PATH} -> ${CLI_PATH}"
  else
    mkdir -p "${BIN_DIR}"
    ln -s "${CLI_PATH}" "${LINK_PATH}"
    info "Installed ${LINK_PATH} -> ${CLI_PATH}"
  fi
fi

if ! path_in_path "${BIN_DIR}"; then
  info "Note: ${BIN_DIR} is not in PATH."
  info "Add this to your shell profile if needed:"
  info "  export PATH=\"${BIN_DIR}:\$PATH\""
fi
