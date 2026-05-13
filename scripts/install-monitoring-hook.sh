#!/usr/bin/env bash
# 설치: ./scripts/install-monitoring-hook.sh
# `core.hooksPath` 를 scripts/git-hooks 로 설정 — main checkout / 워크트리 모두에서 동작.
# 기존에 다른 hook 설정이 있었다면 백업.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
target="scripts/git-hooks"

if [ ! -d "$repo_root/$target" ]; then
  echo "error: $repo_root/$target not found" >&2
  exit 1
fi

prev="$(git config --get core.hooksPath || true)"
if [ -n "$prev" ] && [ "$prev" != "$target" ]; then
  echo "기존 core.hooksPath 백업: $prev  (git config --unset core.hooksPath 으로 복원)"
fi

chmod +x "$repo_root/$target"/* 2>/dev/null || true
git config core.hooksPath "$target"
echo "설치 완료: core.hooksPath = $target"
