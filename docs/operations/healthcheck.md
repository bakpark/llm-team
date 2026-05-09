# Healthcheck CLI

`tsx src/cli/healthcheck.ts` validates the local environment before any
production target run. Three stages, increasing in cost:

| Stage | Cost          | Command                    |
| ----- | ------------- | -------------------------- |
| 1     | none (~5 s)   | `npm run healthcheck:stage1` |
| 2     | none (HTTP)   | `npm run healthcheck:stage2` |
| 3     | live LLM      | `LLM_TEAM_LIVE_HEALTHCHECK=1 npm run healthcheck:stage3` |

## Stage 2 — non-LLM live preflight

- **qwen ping** — HTTP `${LLM_TEAM_QWEN_BASE_URL}/ping` (fallback `/models`).
  Empty URL → SKIP. 200=PASS, 401/403=FAIL(auth), 429=PASS-w/-warning,
  5xx=FAIL(upstream).
- **GitHub `rate_limit`** — `gh api rate_limit`. `remaining < ${LLM_TEAM_GH_RATE_LIMIT_WARN_AT|100}`
  ⇒ PASS w/ low-budget warning; `remaining == 0` ⇒ FAIL.

Per-probe timeout: 5 s.

## Stage 3 — live 1-shot smoke (opt-in only)

Stage 3 is **always SKIP unless** `LLM_TEAM_LIVE_HEALTHCHECK=1`. This is a
hard gate — the CLI exits 0 with no live calls otherwise. Cost is bounded
by two USD caps and a per-day ndjson ledger.

| Env                                  | Default | Purpose                          |
| ------------------------------------ | ------- | -------------------------------- |
| `LLM_TEAM_LIVE_HEALTHCHECK`          | (unset) | `"1"` opts into live probes      |
| `LLM_TEAM_LIVE_COST_CAP_USD`         | `0.10`  | per-run cap                      |
| `LLM_TEAM_LIVE_DAILY_COST_CAP_USD`   | `1.00`  | daily cap (ledger-aggregated)    |
| `LLM_TEAM_HEALTHCHECK_RUN_DIR`       | (auto)  | RUN_DIR override                 |
| `LLM_TEAM_HEALTHCHECK_COST_LEDGER`   | (auto)  | ledger path override             |
| `LLM_TEAM_QWEN_BASE_URL`             | (unset) | qwen Stage-2 ping (also gates    |
|                                      |         | codex-qwen smoke)                |
| `LLM_TEAM_CLAUDE_MODEL`              | (none)  | claude `--model` value           |
| `LLM_TEAM_CODEX_QWEN_PROFILE`        | `qwen`  | codex `--profile` value          |

### Probes

1. **claude 1-shot** — `claude -p --output-format text [--model <m>]`,
   prompt via stdin, 60 s timeout.
2. **codex default 1-shot** — `codex exec --ephemeral --skip-git-repo-check
   --cd <RUN_DIR> --color never <prompt>`. **stdin is `</dev/null`** —
   never piped.
3. **codex qwen 1-shot** — same + `--profile qwen`. Auto-SKIP if Stage 2
   qwen ping was not PASS.

### RUN_DIR layout

```
<RUN_DIR>/
  claude-attempt1.{stdout,stderr,exit,md}
  codex-default-attempt1.{stdout,stderr,exit,md}
  codex-qwen-attempt1.{stdout,stderr,exit,md}
  verified-auth-model.json
  healthcheck-failure.md     # only if any FAIL
```

Default RUN_DIR: `~/.llm-team/healthcheck/<utc-timestamp>/` (mode `0700`).
Never auto-deleted — failures stay on disk for post-mortem.

### Cost ledger

Default path: `~/.llm-team/healthcheck-cost-ledger.ndjson`. One JSON line
per successful spawn:

```json
{"ts":"2026-05-09T10:00:00.000Z","kind":"claude.smoke","estimated_usd":0.005,"run_dir":"/.../healthcheck/2026-05-09..."}
```

Daily cap is computed by summing `estimated_usd` of all entries whose
`ts` falls within the current UTC day. Cap-exceeded probes SKIP (not
FAIL) — the operator decides whether to lift the cap.

### Operator workflow

```
LLM_TEAM_LIVE_HEALTHCHECK=1 \
  LLM_TEAM_QWEN_BASE_URL=https://… \
  npm run healthcheck:stage3
```

Exit 0 ⇒ all live surfaces verified. Inspect
`<RUN_DIR>/verified-auth-model.json` for the per-CLI status snapshot.

CI MUST NOT set `LLM_TEAM_LIVE_HEALTHCHECK=1` unless an explicit budget
gate is in place. The default branch protection runs only Stages 1 and 2.
