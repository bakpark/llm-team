/**
 * FS lease adapter — backs LeasePort with files under `workdir/leases/`.
 *
 * Layout:
 *   - `leases/active/<safe(object_id)>.json` — at most one active lease per
 *     object_id. Created via the underlying StorePort's lockdir CAS so two
 *     processes cannot both succeed.
 *   - `leases/records/<lease_id>.json` — durable record for every lease ever
 *     issued (including released / expired). Used for diagnostic + sweep
 *     replay. The `monotonic_seq` counter for an object lives at
 *     `leases/seq/<safe(object_id)>` and is bumped under the same lockdir.
 *
 * Token: `<monotonic_seq>:<lease_id>`. Adapters and ledger consumers compare
 * tokens lexically (zero-padded counter ensures correctness up to 1e12).
 */
import { newMonotonicId } from "../../domain/ids.js";
import {
  Lease,
  type Lease as LeaseT,
  type LeaseKind,
} from "../../domain/schema/lease.js";
import type { ClockPort } from "../../ports/clock.js";
import type {
  ClaimInput,
  ClaimResult,
  LeasePort,
  ReleaseInput,
  RenewInput,
  SweepStaleInput,
} from "../../ports/lease.js";
import type { StorePort } from "../../ports/store.js";

const ACTIVE_DIR = "leases/active";
const RECORDS_DIR = "leases/records";
const SEQ_DIR = "leases/seq";

export interface FsLeaseOptions {
  store: StorePort;
  clock: ClockPort;
}

export class FsLease implements LeasePort {
  private readonly store: StorePort;
  private readonly clock: ClockPort;

  constructor(opts: FsLeaseOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const safeKey = safeKey1(input.objectId);
    const activePath = `${ACTIVE_DIR}/${safeKey}.json`;
    const seqPath = `${SEQ_DIR}/${safeKey}`;
    return this.store.withFileLock(activePath, async () => {
      const existing = await this.store.readText(activePath);
      // P0-5 fix (PR #63 review): corrupt record disambiguation. The active
      // file is one of three states:
      //   - missing or empty string → no live lease (proceed to claim)
      //   - parses as valid Lease   → live (refuse with claim_failed)
      //   - present but unparseable → CORRUPT. Refuse claim and surface the
      //     condition instead of silently overwriting. The sweeper has no
      //     way to clear a corrupt record (it cannot determine expiry from
      //     a malformed body), so the only safe behaviour is to require
      //     operator intervention. Returning claim_failed with a sentinel
      //     existingHolder makes the failure visible in logs.
      if (existing != null && existing.length > 0) {
        let parsed: LeaseT | null = null;
        try {
          parsed = Lease.parse(JSON.parse(existing));
        } catch {
          parsed = null;
        }
        if (parsed != null) {
          return {
            result: "claim_failed" as const,
            existingHolder: parsed.worker_id,
            existingLeaseId: parsed.lease_id,
          };
        }
        return {
          result: "claim_failed" as const,
          existingHolder: "<corrupt-active-record>",
          existingLeaseId: `<corrupt:${safeKey}>`,
        };
      }
      const seq = await this.bumpSeq(seqPath);
      const leaseId = newMonotonicId(this.clock.now());
      const claimedAt = this.clock.isoNow();
      const expiresAt = isoFromMs(this.clock.now() + input.ttlMs);
      const token = formatToken(seq, leaseId);
      const lease = buildLease({
        kind: input.leaseKind,
        leaseId,
        token,
        targetId: input.targetId,
        objectId: input.objectId,
        workerId: input.workerId,
        claimedAt,
        expiresAt,
        ttlMs: input.ttlMs,
        ttlSource: input.ttlSource,
        aux: input.aux,
      });
      const body = JSON.stringify(lease, null, 2);
      await this.store.writeAtomic(activePath, body);
      await this.store.writeAtomic(`${RECORDS_DIR}/${leaseId}.json`, body);
      return { result: "acquired" as const, lease };
    });
  }

  async release(input: ReleaseInput): Promise<{ released: boolean }> {
    const recordPath = `${RECORDS_DIR}/${input.leaseId}.json`;
    const recordBody = await this.store.readText(recordPath);
    if (recordBody == null) return { released: false };
    let record: LeaseT;
    try {
      record = Lease.parse(JSON.parse(recordBody));
    } catch {
      return { released: false };
    }
    if (record.lease_token !== input.leaseToken) return { released: false };
    const safeKey = safeKey1(record.object_id);
    const activePath = `${ACTIVE_DIR}/${safeKey}.json`;
    return this.store.withFileLock(activePath, async () => {
      const active = await this.store.readText(activePath);
      if (active == null) return { released: false };
      let activeLease: LeaseT;
      try {
        activeLease = Lease.parse(JSON.parse(active));
      } catch {
        // Corrupt active — clear it.
        await this.store.writeAtomic(activePath, "");
        return { released: true };
      }
      if (activeLease.lease_id !== record.lease_id) return { released: false };
      // Mark active as released by removing — writeAtomic("") would parse as
      // valid empty file but our tests rely on file presence. Use empty
      // string as the "released" sentinel so cross-process readers can tell
      // the difference between "no lease ever" and "released". The lockdir
      // semantics ensure no torn states.
      await this.store.writeAtomic(activePath, "");
      return { released: true };
    });
  }

  async renew(input: RenewInput): Promise<{ renewed: boolean; newExpiresAt: string | null }> {
    const recordPath = `${RECORDS_DIR}/${input.leaseId}.json`;
    const recordBody = await this.store.readText(recordPath);
    if (recordBody == null) return { renewed: false, newExpiresAt: null };
    let record: LeaseT;
    try {
      record = Lease.parse(JSON.parse(recordBody));
    } catch {
      return { renewed: false, newExpiresAt: null };
    }
    if (record.lease_token !== input.leaseToken)
      return { renewed: false, newExpiresAt: null };
    const safeKey = safeKey1(record.object_id);
    const activePath = `${ACTIVE_DIR}/${safeKey}.json`;
    return this.store.withFileLock(activePath, async () => {
      const active = await this.store.readText(activePath);
      if (active == null || active.length === 0)
        return { renewed: false, newExpiresAt: null };
      let activeLease: LeaseT;
      try {
        activeLease = Lease.parse(JSON.parse(active));
      } catch {
        return { renewed: false, newExpiresAt: null };
      }
      if (activeLease.lease_id !== record.lease_id)
        return { renewed: false, newExpiresAt: null };
      // P1-7 fix (PR #63 review): refuse renew if the lease is already past
      // expires_at. Otherwise a stale holder could indefinitely defer the
      // sweeper by renewing post-expiry, creating a livelock.
      const liveExp = Date.parse(activeLease.expires_at);
      if (Number.isFinite(liveExp) && liveExp <= this.clock.now())
        return { renewed: false, newExpiresAt: null };
      const newExpiresAt = isoFromMs(this.clock.now() + input.newTtlMs);
      const updated = { ...activeLease, expires_at: newExpiresAt, ttl_ms: input.newTtlMs };
      const body = JSON.stringify(updated, null, 2);
      await this.store.writeAtomic(activePath, body);
      await this.store.writeAtomic(recordPath, body);
      return { renewed: true, newExpiresAt };
    });
  }

  async sweepStale(input?: SweepStaleInput): Promise<LeaseT[]> {
    // P0-1 fix (PR #63 review): TOCTOU-safe sweep. The previous version read
    // the active file outside the lock, judged expiry, then cleared inside
    // the lock without re-checking. A `release → re-claim` racing in between
    // those two steps would have its fresh lease destroyed. Now we re-read
    // INSIDE the lock and only clear if the lease_id we observed initially
    // is still the one in the active slot.
    const now = (input?.now ?? new Date(this.clock.now())).getTime();
    const wanted = input?.kinds == null ? null : new Set<LeaseKind>(input.kinds);
    const expired: LeaseT[] = [];
    const entries = await safeList(this.store, ACTIVE_DIR);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const probe = await this.store.readText(`${ACTIVE_DIR}/${name}`);
      if (probe == null || probe.length === 0) continue;
      let probeLease: LeaseT;
      try {
        probeLease = Lease.parse(JSON.parse(probe));
      } catch {
        continue;
      }
      if (wanted != null && !wanted.has(probeLease.lease_kind)) continue;
      const probeExp = Date.parse(probeLease.expires_at);
      if (!Number.isFinite(probeExp) || probeExp >= now) continue;
      // Candidate — confirm under lock so a concurrent re-claim/renew is not
      // lost.
      const activePath = `${ACTIVE_DIR}/${name}`;
      const swept = await this.store.withFileLock(activePath, async () => {
        const live = await this.store.readText(activePath);
        if (live == null || live.length === 0) return null;
        let liveLease: LeaseT;
        try {
          liveLease = Lease.parse(JSON.parse(live));
        } catch {
          return null;
        }
        // Same lease still occupying the slot AND still expired? Then clear.
        if (liveLease.lease_id !== probeLease.lease_id) return null;
        const liveExp = Date.parse(liveLease.expires_at);
        if (!Number.isFinite(liveExp) || liveExp >= now) return null;
        // P0-4 fix (PR #63 review): the caller (recovery sweeper) needs to
        // emit a ledger row for each expired lease. We return the lease
        // without clearing here — the caller is responsible for emitting
        // the ledger row first, then calling `clearExpired` to drop the
        // active slot. This reverses the previous "clear-then-ledger"
        // ordering: a crash between ledger append and clear means the next
        // sweep will see a duplicate ledger row (absorbed by the recover
        // idempotency_key dedup) and try the clear again — no permanent
        // loss.
        return liveLease;
      });
      if (swept != null) expired.push(swept);
    }
    return expired;
  }

  /**
   * Companion to `sweepStale`: clear the active slot for an already-
   * acknowledged expired lease. Idempotent — clearing an already-empty
   * slot is a no-op. The lease_id check guards against a re-claim that
   * happened after sweepStale returned but before the caller dispatched
   * the clear.
   */
  async clearExpired(lease: LeaseT): Promise<{ cleared: boolean }> {
    const safeKey = safeKey1(lease.object_id);
    const activePath = `${ACTIVE_DIR}/${safeKey}.json`;
    return this.store.withFileLock(activePath, async () => {
      const live = await this.store.readText(activePath);
      if (live == null || live.length === 0) return { cleared: false };
      let liveLease: LeaseT;
      try {
        liveLease = Lease.parse(JSON.parse(live));
      } catch {
        return { cleared: false };
      }
      if (liveLease.lease_id !== lease.lease_id) return { cleared: false };
      await this.store.writeAtomic(activePath, "");
      return { cleared: true };
    });
  }

  async list(): Promise<LeaseT[]> {
    const out: LeaseT[] = [];
    const entries = await safeList(this.store, ACTIVE_DIR);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const body = await this.store.readText(`${ACTIVE_DIR}/${name}`);
      if (body == null || body.length === 0) continue;
      try {
        out.push(Lease.parse(JSON.parse(body)));
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * **MUST be called inside `withFileLock(activePath)`**. The seq counter
   * shares the active-slot lock so two concurrent claims on the same
   * object_id cannot both observe the same `n`. Callers outside `claim`
   * must not invoke this directly.
   */
  private async bumpSeq(seqPath: string): Promise<number> {
    const body = await this.store.readText(seqPath);
    let n = 0;
    if (body != null) {
      const parsed = Number.parseInt(body.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) n = parsed;
    }
    const next = n + 1;
    await this.store.writeAtomic(seqPath, String(next));
    return next;
  }
}

function buildLease(input: {
  kind: LeaseKind;
  leaseId: string;
  token: string;
  targetId: string;
  objectId: string;
  workerId: string;
  claimedAt: string;
  expiresAt: string;
  ttlMs: number;
  ttlSource: LeaseT["ttl_source"];
  aux: ClaimInput["aux"];
}): LeaseT {
  const base = {
    lease_id: input.leaseId,
    lease_token: input.token,
    target_id: input.targetId,
    object_id: input.objectId,
    worker_id: input.workerId,
    claimed_at: input.claimedAt,
    expires_at: input.expiresAt,
    ttl_ms: input.ttlMs,
    ttl_source: input.ttlSource,
  };
  switch (input.aux.kind) {
    case "slot_lock":
      return Lease.parse({
        ...base,
        lease_kind: "slot_lock",
        slot_kind: input.aux.slot_kind,
        milestone_id: input.aux.milestone_id,
      });
    case "slice_lease":
      return Lease.parse({
        ...base,
        lease_kind: "slice_lease",
        slice_id: input.aux.slice_id,
      });
    case "session_lease":
      return Lease.parse({
        ...base,
        lease_kind: "session_lease",
        session_id: input.aux.session_id,
        agent_profile_id: input.aux.agent_profile_id,
      });
    case "turn_lease":
      return Lease.parse({
        ...base,
        lease_kind: "turn_lease",
        session_id: input.aux.session_id,
        turn_index: input.aux.turn_index,
        agent_profile_id: input.aux.agent_profile_id,
      });
  }
}

function safeKey1(objectId: string): string {
  return objectId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function formatToken(seq: number, leaseId: string): string {
  return `${seq.toString().padStart(12, "0")}:${leaseId}`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

async function safeList(store: StorePort, dir: string): Promise<string[]> {
  try {
    return await store.list(dir);
  } catch {
    return [];
  }
}
