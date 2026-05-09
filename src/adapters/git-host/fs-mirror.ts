/**
 * FS-mirror GitHostPort — deterministic PR mirror used by tests and
 * self-hosting targets.
 *
 * Layout (under workdir/external_mirror/prs/<n>.json).
 */

import type { ExternalRefHandle } from "../../ports/issue-tracker.js";
import type {
  GitHostPort,
  OpenPullRequestInput,
  PostPullRequestCommentInput,
  UpdatePullRequestInput,
} from "../../ports/git-host.js";
import type { StorePort } from "../../ports/store.js";

const PROVIDER = "fs-mirror";
const ROOT = "external_mirror";
const COUNTER_PATH = `${ROOT}/_pr_counter.json`;

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
  revision: number;
}

function prPath(n: number): string {
  return `${ROOT}/prs/${n}.json`;
}

interface Counter {
  next_pr: number;
  next_comment: number;
}

async function readCounter(store: StorePort): Promise<Counter> {
  const raw = await store.readText(COUNTER_PATH);
  if (raw == null) return { next_pr: 1, next_comment: 1 };
  return JSON.parse(raw) as Counter;
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
      const c = await readCounter(this.store);
      const id = c.next_comment;
      c.next_comment = id + 1;
      await writeCounter(this.store, c);
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
    const s = JSON.parse(raw) as StoredPr;
    return {
      state: s.state,
      draft: s.draft,
      labels: s.labels,
      title: s.title,
      body: s.body,
      revision: String(s.revision),
    };
  }
}
