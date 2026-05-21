# Monitoring post-commit hook

`~/dev/infra/` 의 `git_commits` 적재용. 설치: `./scripts/install-monitoring-hook.sh`. 실패는 silent (commit 차단 안 함).

ingest URL override: `MONITORING_INGEST_URL=http://mba.local:8080`.
