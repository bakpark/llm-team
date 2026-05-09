/**
 * GitHub NotifierPort — posts a comment on the target issue/PR via `gh`.
 *
 * Idempotency: the `notification_id` is included as an HTML comment marker
 * so re-runs avoid duplicate posts (the adapter scans existing comments
 * before posting). RGC-NOTIFICATION is push-only — failures log and return
 * `{delivered:false}` rather than throwing.
 */

import type {
  NotificationInput,
  NotifierPort,
} from "../../ports/notifier.js";
import type { GhExec } from "../issue-tracker/github.js";

export interface GitHubNotifierOptions {
  repo: string;
  exec: GhExec;
}

const MARKER_PREFIX = "<!-- llm-team-notification-id:";

export class GitHubNotifier implements NotifierPort {
  static readonly provider = "github";
  constructor(private readonly opts: GitHubNotifierOptions) {}

  async notify(
    input: NotificationInput,
  ): Promise<{ delivered: boolean }> {
    const marker = `${MARKER_PREFIX}${input.notificationId} -->`;
    // target encodes "issue:<n>" or "pr:<n>"
    const m = input.target.match(/^(issue|pr):(\d+)$/);
    if (!m) return { delivered: false };
    const kind = m[1] as "issue" | "pr";
    const id = m[2]!;
    try {
      // Check existing comments for the marker.
      const list = await this.opts.exec.run([
        "api",
        `repos/${this.opts.repo}/${kind === "issue" ? "issues" : "issues"}/${id}/comments`,
      ]);
      const items = JSON.parse(list.stdout) as { body: string }[];
      if (items.some((it) => it.body?.includes(input.notificationId))) {
        return { delivered: false };
      }
      const body = `${marker}\n${input.body}`;
      await this.opts.exec.run([
        kind === "pr" ? "pr" : "issue",
        "comment",
        id,
        "--repo",
        this.opts.repo,
        "--body",
        body,
      ]);
      return { delivered: true };
    } catch {
      return { delivered: false };
    }
  }
}
