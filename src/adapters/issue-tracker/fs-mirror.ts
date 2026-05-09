/**
 * FS-mirror IssueTrackerPort — deterministic in-FS implementation used by
 * tests and self-hosting targets.
 *
 * Layout (under workdir/external_mirror/):
 *   milestones/<n>.json
 *   issues/<n>.json
 *
 * `revision` is a monotonically increasing counter per-object so callers can
 * compare against `last_seen_external_revision` for drift detection.
 *
 * The adapter accepts a `clock()` so tests can pin timestamps; not needed
 * for revision (counter is integer string).
 */

import type {
  CreateIssueInput,
  CreateMilestoneInput,
  ExternalRefHandle,
  IssueTrackerPort,
  UpdateIssueInput,
  UpdateMilestoneStateInput,
} from "../../ports/issue-tracker.js";
import type { StorePort } from "../../ports/store.js";

const PROVIDER = "fs-mirror";

interface StoredMilestone {
  number: number;
  title: string;
  body: string;
  labels: string[];
  revision: number;
}

interface StoredIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  milestone_number: number | null;
  revision: number;
  kind: string;
}

const ROOT = "external_mirror";

function milestonePath(n: number): string {
  return `${ROOT}/milestones/${n}.json`;
}
function issuePath(n: number): string {
  return `${ROOT}/issues/${n}.json`;
}
const COUNTER_PATH = `${ROOT}/_counter.json`;

interface Counters {
  next_milestone: number;
  next_issue: number;
}

async function readCounters(store: StorePort): Promise<Counters> {
  const raw = await store.readText(COUNTER_PATH);
  if (raw == null) return { next_milestone: 1, next_issue: 1 };
  return JSON.parse(raw) as Counters;
}

async function writeCounters(
  store: StorePort,
  counters: Counters,
): Promise<void> {
  await store.writeAtomic(COUNTER_PATH, JSON.stringify(counters));
}

export class FsMirrorIssueTracker implements IssueTrackerPort {
  static readonly provider = PROVIDER;

  constructor(private readonly store: StorePort) {}

  async createMilestone(
    input: CreateMilestoneInput,
  ): Promise<ExternalRefHandle> {
    return this.store.withFileLock(COUNTER_PATH, async () => {
      const c = await readCounters(this.store);
      const number = c.next_milestone;
      c.next_milestone = number + 1;
      await writeCounters(this.store, c);
      const labels: string[] = [];
      if (input.stateLabel) labels.push(input.stateLabel);
      if (input.slotLabel) labels.push(input.slotLabel);
      const stored: StoredMilestone = {
        number,
        title: input.title,
        body: input.body ?? "",
        labels,
        revision: 1,
      };
      await this.store.writeAtomic(
        milestonePath(number),
        JSON.stringify(stored),
      );
      return { provider: PROVIDER, id: String(number) };
    });
  }

  async updateMilestoneState(
    input: UpdateMilestoneStateInput,
  ): Promise<ExternalRefHandle> {
    const n = Number(input.milestoneRef.id);
    return this.store.withFileLock(milestonePath(n), async () => {
      const raw = await this.store.readText(milestonePath(n));
      if (raw == null) {
        throw new Error(`fs-mirror: milestone ${n} missing`);
      }
      const cur = JSON.parse(raw) as StoredMilestone;
      cur.labels = [...input.labels];
      if (input.title != null) cur.title = input.title;
      if (input.body != null) cur.body = input.body;
      cur.revision += 1;
      await this.store.writeAtomic(milestonePath(n), JSON.stringify(cur));
      return { provider: PROVIDER, id: String(n) };
    });
  }

  async createIssue(input: CreateIssueInput): Promise<ExternalRefHandle> {
    return this.store.withFileLock(COUNTER_PATH, async () => {
      const c = await readCounters(this.store);
      const number = c.next_issue;
      c.next_issue = number + 1;
      await writeCounters(this.store, c);
      const stored: StoredIssue = {
        number,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
        state: "open",
        milestone_number: input.milestoneRef
          ? Number(input.milestoneRef.id)
          : null,
        revision: 1,
        kind: input.kind,
      };
      await this.store.writeAtomic(issuePath(number), JSON.stringify(stored));
      return { provider: PROVIDER, id: String(number) };
    });
  }

  async updateIssue(input: UpdateIssueInput): Promise<ExternalRefHandle> {
    const n = Number(input.issueRef.id);
    return this.store.withFileLock(issuePath(n), async () => {
      const raw = await this.store.readText(issuePath(n));
      if (raw == null) {
        throw new Error(`fs-mirror: issue ${n} missing`);
      }
      const cur = JSON.parse(raw) as StoredIssue;
      cur.labels = [...input.labels];
      if (input.title != null) cur.title = input.title;
      if (input.body != null) cur.body = input.body;
      if (input.state != null) cur.state = input.state;
      cur.revision += 1;
      await this.store.writeAtomic(issuePath(n), JSON.stringify(cur));
      return { provider: PROVIDER, id: String(n) };
    });
  }

  async fetchIssue(issueRef: ExternalRefHandle) {
    const n = Number(issueRef.id);
    const raw = await this.store.readText(issuePath(n));
    if (raw == null || raw === "") return null;
    const s = JSON.parse(raw) as StoredIssue;
    return {
      state: s.state,
      labels: s.labels,
      title: s.title,
      body: s.body,
      revision: String(s.revision),
    };
  }

  async fetchMilestone(milestoneRef: ExternalRefHandle) {
    const n = Number(milestoneRef.id);
    const raw = await this.store.readText(milestonePath(n));
    if (raw == null) return null;
    const s = JSON.parse(raw) as StoredMilestone;
    return {
      labels: s.labels,
      title: s.title,
      body: s.body,
      revision: String(s.revision),
    };
  }

  /**
   * Test-only mutator — simulate an external (out-of-band) edit without going
   * through the port. Used by drift-observer tests to inject a divergence.
   */
  async __externalMutate(
    ref: ExternalRefHandle,
    fn: (s: StoredIssue) => StoredIssue,
  ): Promise<void> {
    const n = Number(ref.id);
    await this.store.withFileLock(issuePath(n), async () => {
      const raw = await this.store.readText(issuePath(n));
      if (raw == null) throw new Error(`issue ${n} missing`);
      const cur = JSON.parse(raw) as StoredIssue;
      const next = fn(cur);
      next.revision = cur.revision + 1;
      await this.store.writeAtomic(issuePath(n), JSON.stringify(next));
    });
  }

  async __externalDelete(ref: ExternalRefHandle): Promise<void> {
    const n = Number(ref.id);
    await this.store.withFileLock(issuePath(n), async () => {
      // simulate orphan — replace with sentinel by writing empty / removing
      // we cannot remove via StorePort; write a tombstone the fetch treats as null
      await this.store.writeAtomic(issuePath(n), "");
    });
  }
}
