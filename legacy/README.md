# Legacy Runtime

This directory contains the pre-contract MVP runtime:

- `PO/PM/DEV/QA` role split
- legacy GitHub labels such as `needs-dev`, `needs-qa`, `qa:in-progress`
- Agent-executed `gh` / `git` operations in the DEV and QA prompts

It is kept only as historical reference. Active implementation work must use
the root `scheduler/`, `prompts/`, `lib/`, and `tests/` paths, which follow
`llm-team.md` and `docs/contracts/`.
