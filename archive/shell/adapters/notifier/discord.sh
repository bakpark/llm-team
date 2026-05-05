#!/usr/bin/env bash
# adapters/notifier/discord.sh
#
# Discord webhook notifier adapter.
# 의존: TARGET_NOTIFIER_REF (resolve_secret 가 lookup 할 키), curl, jq.
# 비밀이 없거나 curl/jq 가 없으면 warn 후 비0 반환 — 워크플로우는 중단되지 않는다.

# nt_send <kind> <url> <summary>
nt_send() {
  local kind="$1" url="$2" summary="$3"
  local target="${TARGET_NAME:-unknown}"

  local webhook
  if ! webhook="$(resolve_secret "${TARGET_NOTIFIER_REF}" 2>/dev/null)"; then
    log_warn "nt_send(discord): webhook secret '${TARGET_NOTIFIER_REF}' missing; skipping"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log_warn "nt_send(discord): curl not available; skipping"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log_warn "nt_send(discord): jq not available; skipping"
    return 1
  fi

  local payload
  payload="$(jq -n \
    --arg t "${target}" \
    --arg k "${kind}" \
    --arg u "${url}" \
    --arg s "${summary}" \
    '{embeds: [{title: ("[" + $t + "] " + $k + " — Human Review Required"),
                url: $u, description: $s, color: 15158332}]}')"

  if curl -s --fail -X POST -H "Content-Type: application/json" \
       -d "${payload}" "${webhook}" >/dev/null; then
    return 0
  fi
  log_warn "nt_send(discord): webhook POST failed"
  return 1
}
