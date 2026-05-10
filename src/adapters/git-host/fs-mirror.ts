/**
 * FS-mirror GitHostPort — deterministic PR mirror used by tests and
 * self-hosting targets.
 *
 * Layout (under workdir/external_mirror/prs/<n>.json).
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
import type { StorePort } from "../../ports/store.js";

const PROVIDER = "fs-mirror";
const ROOT = "external_mirror";
const COUNTER_PATH = `${ROOT}/_pr_counter.json`;

interface StoredReview {
  id: number;
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string;
  submittedAt: string | null;
}

interface StoredPr {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  base: string;
  linked_issue: string | null;
  comments: { id: number; body: string }[];
  reviews: StoredReview[];
  diff: string;
  merge_commit_sha: string | null;
  revision: number;
}

function prPath(n: number): string {
  return `${ROOT}/prs/${n}.json`;
}

interface Counter {
  next_pr: number;
  next_comment: number;
  next_review: number;
}

async function readCounter(store: StorePort): Promise<Counter> {
  const raw = await store.readText(COUNTER_PATH);
  if (raw == null) return { next_pr: 1, next_comment: 1, next_review: 1 };
  const parsed = JSON.parse(raw) as Partial<Counter>;
  return {
    next_pr: parsed.next_pr ?? 1,
    next_comment: parsed.next_comment ?? 1,
    next_review: parsed.next_review ?? 1,
  };
}

async function writeCounter(
  store: StorePort,
  c: Counter,
): Promise<void> {
  await store.writeAtomic(COUNTER_PATH, JSON.stringify(c));
}

export class FsMirrorGitHost implements GitHostPort {
  static readonly provider = PROVIDER;

  constructor(private readonly store: StorePort) {}

  async openPullRequest(
    input: OpenPullRequestInput,
  ): Promise<ExternalRefHandle> {
    return this.store.withFileLock(COUNTER_PATH, async () => {
      const c = await readCounter(this.store);
      const number = c.next_pr;
      c.next_pr = number + 1;
      await writeCounter(this.store, c);
      const stored: StoredPr = {
        number,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
        state: "open",
        draft: input.draft,
        head: input.headBranch,
        base: input.baseBranch,
        linked_issue: input.linkedIssueRef
          ? input.linkedIssueRef.id
          : null,
        comments: [],
        reviews: [],
        diff: "",
        merge_commit_sha: null,
        revision: 1,
      };
      await this.store.writeAtomic(prPath(number), JSON.stringify(stored));
      return { provider: PROVIDER, id: String(number) };
    });
  }

  async updatePullRequest(
    input: UpdatePullRequestInput,
  ): Promise<ExternalRefHandle> {
    const n = Number(input.prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = JSON.parse(raw) as StoredPr;
      if (input.draft != null) cur.draft = input.draft;
      if (input.state != null) cur.state = input.state;
      if (input.labels != null) cur.labels = [...input.labels];
      if (input.title != null) cur.title = input.title;
      if (input.body != null) cur.body = input.body;
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { provider: PROVIDER, id: String(n) };
    });
  }

  async postPullRequestComment(
    input: PostPullRequestCommentInput,
  ): Promise<{ commentId: string }> {
    const n = Number(input.prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = JSON.parse(raw) as StoredPr;
      // PR #71 P0-2: counter mutation must be guarded by COUNTER_PATH lock
      // so concurrent comment posts on different PRs cannot race the same
      // `next_comment` value. Nesting order prPath → COUNTER_PATH is the
      // only direction used in this adapter (openPullRequest takes
      // COUNTER_PATH alone), so no cycle is possible.
      const id = await this.store.withFileLock(COUNTER_PATH, async () => {
        const c = await readCounter(this.store);
        const next = c.next_comment;
        c.next_comment = next + 1;
        await writeCounter(this.store, c);
        return next;
      });
      cur.comments.push({ id, body: input.body });
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { commentId: String(id) };
    });
  }

  async fetchPullRequest(prRef: ExternalRefHandle) {
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "") return null;
    const s = readStoredPr(raw);
    return {
      state: s.state,
      draft: s.draft,
      labels: s.labels,
      title: s.title,
      body: s.body,
      revision: String(s.revision),
    };
  }

  // ---------- Phase 1 additive surface ----------

  /** Test seeder — overwrite the PR's diff body. */
  async seedDiff(prRef: ExternalRefHandle, diff: string): Promise<void> {
    const n = Number(prRef.id);
    await this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      cur.diff = diff;
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
    });
  }

  async submitPullRequestReview(
    input: SubmitPullRequestReviewInput,
  ): Promise<SubmittedReview> {
    const n = Number(input.prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      const id = await this.store.withFileLock(COUNTER_PATH, async () => {
        const c = await readCounter(this.store);
        const next = c.next_review;
        c.next_review = next + 1;
        await writeCounter(this.store, c);
        return next;
      });
      const state =
        input.intent === "approve"
          ? "approved"
          : input.intent === "request_changes"
            ? "changes_requested"
            : "commented";
      const review: StoredReview = {
        id,
        author: PROVIDER,
        state,
        body: input.body,
        submittedAt: new Date(0).toISOString(),
      };
      cur.reviews.push(review);
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { externalReviewId: String(id) };
    });
  }

  async listPullRequestReviews(
    prRef: ExternalRefHandle,
  ): Promise<ListedReview[]> {
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "") return [];
    const cur = readStoredPr(raw);
    return cur.reviews.map((r) => ({
      externalReviewId: String(r.id),
      author: r.author,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
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
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "") return "";
    return readStoredPr(raw).diff;
  }

  async mergePullRequest(
    input: MergePullRequestInput,
  ): Promise<MergePullRequestResult> {
    const n = Number(input.prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      cur.state = "merged";
      cur.merge_commit_sha = `merge-${cur.number}-${cur.revision + 1}`;
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { mergeCommitSha: cur.merge_commit_sha };
    });
  }

  async addLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle> {
    const n = Number(prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      if (!cur.labels.includes(label)) cur.labels.push(label);
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { provider: PROVIDER, id: String(n) };
    });
  }

  async removeLabel(
    prRef: ExternalRefHandle,
    label: string,
  ): Promise<ExternalRefHandle> {
    const n = Number(prRef.id);
    return this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      cur.labels = cur.labels.filter((l) => l !== label);
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
      return { provider: PROVIDER, id: String(n) };
    });
  }

  async dismissReview(input: DismissReviewInput): Promise<void> {
    const n = Number(input.prRef.id);
    await this.store.withFileLock(prPath(n), async () => {
      const raw = await this.store.readText(prPath(n));
      if (raw == null) throw new Error(`fs-mirror: pr ${n} missing`);
      const cur = readStoredPr(raw);
      const target = cur.reviews.find(
        (r) => String(r.id) === input.externalReviewId,
      );
      if (target == null) return;
      target.state = "dismissed";
      cur.revision += 1;
      await this.store.writeAtomic(prPath(n), JSON.stringify(cur));
    });
  }

  // ---------- dedup probes ----------

  async findOpenPullRequestByMachineKey(
    headBranch: string,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null> {
    const ids = await this.store.list(`${ROOT}/prs`);
    for (const entry of ids) {
      const m = /^(\d+)\.json$/.exec(entry);
      if (m == null) continue;
      const raw = await this.store.readText(prPath(Number(m[1]))) ?? "";
      if (raw.length === 0) continue;
      const cur = readStoredPr(raw);
      if (cur.state !== "open") continue;
      if (cur.head !== headBranch) continue;
      if (bodyContainsMachineKey(cur.body, "pr", idempotencyKey)) {
        return { provider: PROVIDER, id: String(cur.number) };
      }
    }
    return null;
  }

  async findPullRequestByBodyMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ExternalRefHandle | null> {
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "") return null;
    const cur = readStoredPr(raw);
    if (bodyContainsMachineKey(cur.body, "pr", idempotencyKey)) {
      return { provider: PROVIDER, id: String(n) };
    }
    return null;
  }

  async findReviewByMachineKey(
    prRef: ExternalRefHandle,
    idempotencyKey: string,
  ): Promise<ListedReview | null> {
    const reviews = await this.listPullRequestReviews(prRef);
    for (const r of reviews) {
      if (bodyContainsMachineKey(r.body, "review", idempotencyKey)) {
        return r;
      }
    }
    return null;
  }

  async getPullRequestMergeState(
    prRef: ExternalRefHandle,
  ): Promise<PullRequestMergeState> {
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "")
      return { state: "closed", mergeCommitSha: null };
    const cur = readStoredPr(raw);
    return {
      state: cur.state,
      mergeCommitSha: cur.merge_commit_sha,
    };
  }

  async listLabels(prRef: ExternalRefHandle): Promise<string[]> {
    const n = Number(prRef.id);
    const raw = await this.store.readText(prPath(n));
    if (raw == null || raw === "") return [];
    return [...readStoredPr(raw).labels];
  }

  async getReview(
    prRef: ExternalRefHandle,
    externalReviewId: string,
  ): Promise<ListedReview | null> {
    const reviews = await this.listPullRequestReviews(prRef);
    return reviews.find((r) => r.externalReviewId === externalReviewId) ?? null;
  }
}

function readStoredPr(raw: string): StoredPr {
  const parsed = JSON.parse(raw) as Partial<StoredPr> & { number: number };
  return {
    number: parsed.number,
    title: parsed.title ?? "",
    body: parsed.body ?? "",
    labels: parsed.labels ?? [],
    state: parsed.state ?? "open",
    draft: parsed.draft ?? false,
    head: parsed.head ?? "",
    base: parsed.base ?? "",
    linked_issue: parsed.linked_issue ?? null,
    comments: parsed.comments ?? [],
    reviews: parsed.reviews ?? [],
    diff: parsed.diff ?? "",
    merge_commit_sha: parsed.merge_commit_sha ?? null,
    revision: parsed.revision ?? 1,
  };
}

/**
 * Lightweight regex check shared by dedup probes. The authoritative
 * machine-block parser lives in `src/application/machine-block.ts` (Phase 1).
 * Here we only need the idempotency_key inside the last machine block of a
 * given block_kind.
 */
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
