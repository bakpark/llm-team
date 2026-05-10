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
  DismissReviewInput,
  GitHostPort,
  ListedReview,
  MergePullRequestInput,
  MergePullRequestResult,
  OpenPullRequestInput,
  PostPullRequestCommentInput,
  PullRequestMergeState,
  SubmitPullRequestReviewInput,
  SubmittedReview,
  UpdatePullRequestBodyInput,
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

  // ---------- Phase 1 additive surface (cli-spicy-anchor.md §1 step 2) ----------
  //
  // Phase 1 is additive: callers (lead-invoker / reviewer-invoker / outbox)
  // are wired in Phase 2/3. The implementations below shell out to `gh`
  // using the smallest set of flags that matches the documented behavior.
  // No existing callers reach these paths in Phase 1.

  async submitPullRequestReview(
    input: SubmitPullRequestReviewInput,
  ): Promise<SubmittedReview> {
    // `gh pr review <num>` supports `--approve | --request-changes | --comment`
    // plus `--body <md>`. There is no native flag to pin a review id, so we
    // rely on the caller-side machine-block + last-match dedup probe to
    // recover after crashes (cli-spicy-anchor.md §7-2).
    const args = ["pr", "review", input.prRef.id, "--repo", this.opts.repo];
    if (input.intent === "approve") args.push("--approve");
    else if (input.intent === "request_changes") args.push("--request-changes");
    else args.push("--comment");
    args.push("--body", input.body);
    await this.opts.exec.run(args);

    // Read back the most recent review id matching the body's idempotency_key.
    const reviews = await this.listPullRequestReviews(input.prRef);
    const matched = reviews.find((r) =>
      r.body.includes(`idempotency_key: ${input.idempotencyKey}`),
    );
    if (matched == null) {
      throw new Error(
        `gh pr review: posted review not visible after submit (key=${input.idempotencyKey})`,
      );
    }
    return { externalReviewId: matched.externalReviewId };
  }

  async listPullRequestReviews(
    prRef: ExternalRefHandle,
  ): Promise<ListedReview[]> {
    const res = await this.opts.exec.run([
      "pr",
      "view",
      prRef.id,
      "--repo",
      this.opts.repo,
      "--json",
      "reviews",
    ]);
    const parsed = JSON.parse(res.stdout) as {
      reviews?: {
        id?: string;
        databaseId?: number;
        author?: { login?: string };
        state?: string;
        body?: string;
        submittedAt?: string | null;
      }[];
    };
    return (parsed.reviews ?? []).map((r) => ({
      externalReviewId:
        r.id ?? (r.databaseId != null ? String(r.databaseId) : ""),
      author: r.author?.login ?? "",
      state: mapReviewState(r.state ?? ""),
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? null,
    }));
  }

  async updatePullRequestBody(
    input: UpdatePullRequestBodyInput,
  ): Promise<ExternalRefHandle> {
    return this.updatePullRequest({
      prRef: input.prRef,
      body: input.body,
    });
  }

  async getPullRequestDiff(prRef: ExternalRefHandle): Promise<string> {
    const res = await this.opts.exec.run([
      "pr",
      "diff",
      prRef.id,
      "--repo",
      this.opts.repo,
    ]);
    return res.stdout;
  }

  async mergePullRequest(
    input: MergePullRequestInput,
  ): Promise<MergePullRequestResult> {
    const args = [
      "pr",
      "merge",
      input.prRef.id,
      "--repo",
      this.opts.repo,
    ];
    if (input.strategy === "squash") args.push("--squash");
    else if (input.strategy === "merge") args.push("--merge");
    else args.push("--rebase");
    if (input.commitTitle != null) args.push("--subject", input.commitTitle);
    if (input.commitMessage != null) args.push("--body", input.commitMessage);
    await this.opts.exec.run(args);
    const state = await this.getPullRequestMergeState(input.prRef);
    if (state.mergeCommitSha == null) {
      throw new Error(
        `gh pr merge: merge commit sha not available for pr=${input.prRef.id}`,
      );
    }
    return { mergeCommitSha: state.mergeCommitSha };
  }

  async addLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle> {
    await this.opts.exec.run([
      "pr",
      "edit",
      prRef.id,
      "--repo",
      this.opts.repo,
      "--add-label",
      this.prefix(label),
    ]);
    return prRef;
  }

  async removeLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle> {
    await this.opts.exec.run([
      "pr",
      "edit",
      prRef.id,
      "--repo",
      this.opts.repo,
      "--remove-label",
      this.prefix(label),
    ]);
    return prRef;
  }

  async dismissReview(input: DismissReviewInput): Promise<void> {
    // gh exposes review dismissal only via the GraphQL API.
    const message = input.message ?? "Dismissed by Caller";
    await this.opts.exec.run([
      "api",
      "graphql",
      "-F",
      `reviewId=${input.externalReviewId}`,
      "-F",
      `message=${message}`,
      "-f",
      "query=mutation($reviewId:ID!,$message:String!){dismissPullRequestReview(input:{pullRequestReviewId:$reviewId,message:$message}){clientMutationId}}",
    ]);
  }

  // ---------- dedup probes ----------

  async findOpenPullRequestByMachineKey(
    headBranch: string,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null> {
    const res = await this.opts.exec.run([
      "pr",
      "list",
      "--repo",
      this.opts.repo,
      "--head",
      headBranch,
      "--state",
      "open",
      "--json",
      "number,body,url",
    ]);
    const list = JSON.parse(res.stdout) as {
      number: number;
      body?: string;
      url?: string;
    }[];
    for (const pr of list) {
      if (
        pr.body &&
        bodyContainsMachineKey(pr.body, "pr", idempotencyKey)
      ) {
        return {
          provider: PROVIDER,
          id: String(pr.number),
          url: pr.url,
        };
      }
    }
    return null;
  }

  async findPullRequestByBodyMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null> {
    const cur = await this.fetchPullRequest(prRef);
    if (cur == null) return null;
    if (bodyContainsMachineKey(cur.body, "pr", idempotencyKey)) return prRef;
    return null;
  }

  async findReviewByMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ListedReview | null> {
    const reviews = await this.listPullRequestReviews(prRef);
    for (const r of reviews) {
      if (bodyContainsMachineKey(r.body, "review", idempotencyKey)) return r;
    }
    return null;
  }

  async getPullRequestMergeState(
    prRef: ExternalRefHandle,
  ): Promise<PullRequestMergeState> {
    const res = await this.opts.exec.run([
      "pr",
      "view",
      prRef.id,
      "--repo",
      this.opts.repo,
      "--json",
      "state,mergeCommit",
    ]);
    const parsed = JSON.parse(res.stdout) as {
      state?: string;
      mergeCommit?: { oid?: string } | null;
    };
    const mapped =
      parsed.state === "OPEN"
        ? "open"
        : parsed.state === "MERGED"
          ? "merged"
          : "closed";
    return {
      state: mapped,
      mergeCommitSha: parsed.mergeCommit?.oid ?? null,
    };
  }

  async listLabels(prRef: ExternalRefHandle): Promise<string[]> {
    const cur = await this.fetchPullRequest(prRef);
    return cur?.labels ?? [];
  }

  async getReview(
    prRef: ExternalRefHandle,
    externalReviewId: string,
  ): Promise<ListedReview | null> {
    const reviews = await this.listPullRequestReviews(prRef);
    return reviews.find((r) => r.externalReviewId === externalReviewId) ?? null;
  }
}

function mapReviewState(state: string): ListedReview["state"] {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

function bodyContainsMachineKey(
  body: string,
  blockKind: "pr" | "review",
  idempotencyKey: string,
): boolean {
  const re = new RegExp(
    `<!--\\s*llm-team:${blockKind}-machine\\b([\\s\\S]*?)-->`,
    "g",
  );
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m;
  if (last == null) return false;
  const inner = last[1] ?? "";
  const keyRe = /^idempotency_key:\s*(.+)$/m;
  const km = keyRe.exec(inner);
  if (km == null) return false;
  return km[1]?.trim() === idempotencyKey;
}
