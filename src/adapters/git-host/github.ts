/**
 * GitHub GitHostPort — `gh pr` CLI wrapper.
 *
 * Mirrors the SliceMerge ↔ PR mapping in
 * `external-tracking-mapping.md` §4. Native review verdicts are not posted
 * here — they are mediated through the middle review session SessionTurn
 * mirror (`worktree-pr-lifecycle.md` §5.1).
 */

import type { ExternalRefHandle } from "../../ports/issue-tracker.js";
import type {
  GitHostPort,
  OpenPullRequestInput,
  PostPullRequestCommentInput,
  UpdatePullRequestInput,
} from "../../ports/git-host.js";
import type { GhExec } from "../issue-tracker/github.js";

const PROVIDER = "github";

export interface GitHubGitHostOptions {
  repo: string;
  exec: GhExec;
  labelPrefix?: string;
}

interface GhPrJson {
  number: number;
  title: string;
  body?: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  labels?: { name: string }[];
  updatedAt?: string;
}

export class GitHubGitHost implements GitHostPort {
  static readonly provider = PROVIDER;
  constructor(private readonly opts: GitHubGitHostOptions) {}

  private prefix(label: string): string {
    if (!this.opts.labelPrefix) return label;
    return `${this.opts.labelPrefix}/${label}`;
  }

  async openPullRequest(
    input: OpenPullRequestInput,
  ): Promise<ExternalRefHandle> {
    const args = [
      "pr",
      "create",
      "--repo",
      this.opts.repo,
      "--head",
      input.headBranch,
      "--base",
      input.baseBranch,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) args.push("--draft");
    for (const lbl of input.labels) {
      args.push("--label", this.prefix(lbl));
    }
    const res = await this.opts.exec.run(args);
    const url = res.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`gh pr create: cannot parse url ${url}`);
    return { provider: PROVIDER, id: m[1]!, url };
  }

  async updatePullRequest(
    input: UpdatePullRequestInput,
  ): Promise<ExternalRefHandle> {
    if (input.draft === false) {
      await this.opts.exec.run([
        "pr",
        "ready",
        input.prRef.id,
        "--repo",
        this.opts.repo,
      ]);
    }
    if (input.title != null || input.body != null || input.labels != null) {
      const args = [
        "pr",
        "edit",
        input.prRef.id,
        "--repo",
        this.opts.repo,
      ];
      if (input.title != null) args.push("--title", input.title);
      if (input.body != null) args.push("--body", input.body);
      if (input.labels != null) {
        const cur = await this.fetchPullRequest(input.prRef);
        const curLabels = new Set(cur?.labels ?? []);
        const want = new Set(input.labels.map((l) => this.prefix(l)));
        for (const lbl of curLabels)
          if (!want.has(lbl)) args.push("--remove-label", lbl);
        for (const lbl of want)
          if (!curLabels.has(lbl)) args.push("--add-label", lbl);
      }
      await this.opts.exec.run(args);
    }
    if (input.state === "closed") {
      await this.opts.exec.run([
        "pr",
        "close",
        input.prRef.id,
        "--repo",
        this.opts.repo,
      ]);
    } else if (input.state === "merged") {
      await this.opts.exec.run([
        "pr",
        "merge",
        input.prRef.id,
        "--repo",
        this.opts.repo,
        "--squash",
      ]);
    }
    return input.prRef;
  }

  async postPullRequestComment(
    input: PostPullRequestCommentInput,
  ): Promise<{ commentId: string }> {
    const res = await this.opts.exec.run([
      "pr",
      "comment",
      input.prRef.id,
      "--repo",
      this.opts.repo,
      "--body",
      input.body,
    ]);
    const url = res.stdout.trim();
    return { commentId: url };
  }

  async fetchPullRequest(prRef: ExternalRefHandle) {
    try {
      const res = await this.opts.exec.run([
        "pr",
        "view",
        prRef.id,
        "--repo",
        this.opts.repo,
        "--json",
        "number,title,body,state,isDraft,labels,updatedAt",
      ]);
      const j = JSON.parse(res.stdout) as GhPrJson;
      const state =
        j.state === "OPEN"
          ? "open"
          : j.state === "MERGED"
            ? "merged"
            : "closed";
      return {
        state: state as "open" | "closed" | "merged",
        draft: j.isDraft ?? false,
        labels: (j.labels ?? []).map((l) => l.name),
        title: j.title,
        body: j.body ?? "",
        revision: j.updatedAt ?? "",
      };
    } catch {
      return null;
    }
  }
}
