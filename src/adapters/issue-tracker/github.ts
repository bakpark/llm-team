/**
 * GitHub IssueTrackerPort adapter — `gh` CLI wrapper.
 *
 * The mapping is authoritative in
 * `docs/architecture/external-tracking-mapping.md` (provider="github").
 *
 * Reasons for `gh` over Octokit:
 *   - Repo already uses `gh` for PR/issue I/O (gh pr create / gh pr view).
 *   - No new npm dependency required.
 *   - `gh` handles auth via `GH_TOKEN` / login state (Inv #4 — auth lives
 *     outside the controller code).
 *
 * The adapter is implemented as a thin shell around an `Exec` interface so
 * tests can substitute a deterministic mock without touching the real
 * network.
 */

import type {
  CreateIssueInput,
  CreateMilestoneInput,
  ExternalRefHandle,
  IssueTrackerPort,
  UpdateIssueInput,
  UpdateMilestoneStateInput,
} from "../../ports/issue-tracker.js";

const PROVIDER = "github";

export interface GhExec {
  /**
   * Run a `gh` invocation. Returns stdout on success.
   * Implementations MUST throw on non-zero exit; the error message should
   * include stderr so the timeline / drift observer can record
   * `last_sync_error`.
   */
  run(args: string[], stdin?: string): Promise<{ stdout: string }>;
}

export interface GitHubIssueTrackerOptions {
  /** Owner/repo string in `owner/name` form. */
  repo: string;
  exec: GhExec;
  /**
   * Optional label prefix override. When provided, all label writes prepend
   * `<prefix>/` to the produced label. Mirrors `target.label_prefix`.
   */
  labelPrefix?: string;
}

function applyPrefix(prefix: string | undefined, label: string): string {
  if (!prefix) return label;
  return `${prefix}/${label}`;
}

interface GhIssueJson {
  number: number;
  title: string;
  body?: string;
  state: "OPEN" | "CLOSED" | string;
  labels?: { name: string }[];
  updatedAt?: string;
}

interface GhMilestoneJson {
  number: number;
  title: string;
  description?: string;
  state?: string;
  updatedAt?: string;
}

export class GitHubIssueTracker implements IssueTrackerPort {
  static readonly provider = PROVIDER;

  constructor(private readonly opts: GitHubIssueTrackerOptions) {}

  private prefix(label: string): string {
    return applyPrefix(this.opts.labelPrefix, label);
  }

  async createMilestone(
    input: CreateMilestoneInput,
  ): Promise<ExternalRefHandle> {
    // gh has no first-class milestone create; use REST via `gh api`.
    const body = JSON.stringify({
      title: input.title,
      description: input.body ?? "",
      state: "open",
    });
    const res = await this.opts.exec.run(
      [
        "api",
        "-X",
        "POST",
        `repos/${this.opts.repo}/milestones`,
        "--input",
        "-",
      ],
      body,
    );
    const parsed = JSON.parse(res.stdout) as GhMilestoneJson;
    const ref: ExternalRefHandle = {
      provider: PROVIDER,
      id: String(parsed.number),
    };
    // Milestones use labels indirectly — we apply slot/state labels by
    // updating a parent issue (milestone-tracker). The milestone description
    // already carries the state label string in body.
    if (input.stateLabel || input.slotLabel) {
      // labels on milestone surface in our convention live in title/body
      // markers; nothing to do here. Tracker issue carries label set.
    }
    return ref;
  }

  async updateMilestoneState(
    input: UpdateMilestoneStateInput,
  ): Promise<ExternalRefHandle> {
    // PR #71 P1-2 — `labels` is intentionally NOT applied here.
    //
    // GitHub's REST API does not attach labels to milestone resources
    // directly (labels live on issues/PRs). In our convention the milestone
    // surface only carries title/description; the slot/state label set
    // travels on the milestone-tracker issue (see external-tracking-mapping
    // §4). The fs-mirror adapter persists `labels` because its mirror layout
    // is symmetric across object kinds; the github adapter must drop them
    // here. Callers that need label visibility on github MUST update the
    // milestone-tracker issue via `updateIssue` instead.
    //
    // We surface the divergence on stderr so it is observable in logs but
    // do not throw — the contract on this method is "best-effort apply
    // server-side fields supported by the provider".
    if (input.labels.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[github] updateMilestoneState: labels ignored on github milestones ` +
          `(milestone=${input.milestoneRef.id}, count=${input.labels.length}). ` +
          `Apply via the milestone-tracker issue.`,
      );
    }
    const body: Record<string, unknown> = {};
    if (input.title != null) body.title = input.title;
    if (input.body != null) body.description = input.body;
    if (Object.keys(body).length > 0) {
      await this.opts.exec.run(
        [
          "api",
          "-X",
          "PATCH",
          `repos/${this.opts.repo}/milestones/${input.milestoneRef.id}`,
          "--input",
          "-",
        ],
        JSON.stringify(body),
      );
    }
    return input.milestoneRef;
  }

  async createIssue(input: CreateIssueInput): Promise<ExternalRefHandle> {
    const args = [
      "issue",
      "create",
      "--repo",
      this.opts.repo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    for (const lbl of input.labels) {
      args.push("--label", this.prefix(lbl));
    }
    if (input.milestoneRef) {
      args.push("--milestone", input.milestoneRef.id);
    }
    const res = await this.opts.exec.run(args);
    // `gh issue create` prints the URL; parse trailing /<n>
    const url = res.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/issues\/(\d+)/);
    if (!m) throw new Error(`gh issue create: cannot parse url ${url}`);
    return { provider: PROVIDER, id: m[1]!, url };
  }

  async updateIssue(input: UpdateIssueInput): Promise<ExternalRefHandle> {
    // labels: replace
    const args = [
      "issue",
      "edit",
      input.issueRef.id,
      "--repo",
      this.opts.repo,
    ];
    if (input.title != null) {
      args.push("--title", input.title);
    }
    if (input.body != null) {
      args.push("--body", input.body);
    }
    // gh has no atomic label-replace; use --add-label after stripping all.
    // Simpler: drop the label set on the issue first via --remove-label "*"
    // is not supported. We emit two operations: 1) fetch current 2) diff.
    let labelOpsAdded = false;
    if (input.labels) {
      const cur = await this.fetchIssue(input.issueRef);
      const curLabels = new Set(cur?.labels ?? []);
      const want = new Set(input.labels.map((l) => this.prefix(l)));
      for (const lbl of curLabels) {
        if (!want.has(lbl)) {
          args.push("--remove-label", lbl);
          labelOpsAdded = true;
        }
      }
      for (const lbl of want) {
        if (!curLabels.has(lbl)) {
          args.push("--add-label", lbl);
          labelOpsAdded = true;
        }
      }
    }
    // Only invoke `gh issue edit` when there is at least one mutation
    // (title / body / label diff). An empty edit call would be a no-op
    // round-trip at best and could surface as a CLI error at worst.
    if (input.title != null || input.body != null || labelOpsAdded) {
      await this.opts.exec.run(args);
    }
    if (input.state === "closed") {
      await this.opts.exec.run([
        "issue",
        "close",
        input.issueRef.id,
        "--repo",
        this.opts.repo,
      ]);
    } else if (input.state === "open") {
      await this.opts.exec.run([
        "issue",
        "reopen",
        input.issueRef.id,
        "--repo",
        this.opts.repo,
      ]);
    }
    return input.issueRef;
  }

  async fetchIssue(issueRef: ExternalRefHandle) {
    try {
      const res = await this.opts.exec.run([
        "issue",
        "view",
        issueRef.id,
        "--repo",
        this.opts.repo,
        "--json",
        "number,title,body,state,labels,updatedAt",
      ]);
      const j = JSON.parse(res.stdout) as GhIssueJson;
      return {
        state: (j.state.toLowerCase() === "open" ? "open" : "closed") as
          | "open"
          | "closed",
        labels: (j.labels ?? []).map((l) => l.name),
        title: j.title,
        body: j.body ?? "",
        revision: j.updatedAt ?? "",
      };
    } catch {
      return null;
    }
  }

  async fetchMilestone(milestoneRef: ExternalRefHandle) {
    try {
      const res = await this.opts.exec.run([
        "api",
        `repos/${this.opts.repo}/milestones/${milestoneRef.id}`,
      ]);
      const j = JSON.parse(res.stdout) as GhMilestoneJson;
      return {
        labels: [],
        title: j.title,
        body: j.description ?? "",
        revision: j.updatedAt ?? "",
      };
    } catch {
      return null;
    }
  }
}
