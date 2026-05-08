/**
 * FS-channel adapter for RGC-SIGNALS.
 *
 * Layout:
 *   workdir/human_signals/<signal_id>.json            # raw envelope dropped by human
 *   workdir/human_signals/processed/<signal_id>.json  # post-processing record
 *
 * Atomic write (rename-after-write) is delegated to StorePort.writeAtomic —
 * the same FsStore primitive that protects every other persistent object.
 *
 * Idempotency: a signal_id appearing in `processed/` is treated as resolved
 * and excluded from `listPending`. Concurrent drains are serialized via the
 * StorePort's per-path withFileLock.
 */
import {
  HumanSignalEnvelope,
  HumanSignalRecord,
} from "../../domain/schema/human-signal.js";
import { layout } from "../../application/persistence-layout.js";
import type { StorePort } from "../../ports/store.js";
import type { HumanSignalPort } from "../../ports/human-signal.js";

export class FsHumanSignal implements HumanSignalPort {
  constructor(private readonly store: StorePort) {}

  async listPending(): Promise<HumanSignalEnvelope[]> {
    let names: string[];
    try {
      names = await this.store.list("human_signals");
    } catch {
      return [];
    }

    const processed = new Set<string>();
    try {
      for (const name of await this.store.list("human_signals/processed")) {
        if (name.endsWith(".json"))
          processed.add(name.slice(0, -".json".length));
      }
    } catch {
      // processed/ may not exist yet.
    }

    const out: HumanSignalEnvelope[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (processed.has(id)) continue;
      const body = await this.store.readText(`human_signals/${name}`);
      if (body == null) continue;
      try {
        const env = HumanSignalEnvelope.parse(JSON.parse(body));
        out.push(env);
      } catch {
        // Corrupt envelope — caller will record invalid via markProcessed
        // when it re-reads with stricter validation. Skip in listing for
        // now to avoid blocking the queue.
      }
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  async markProcessed(input: {
    signalId: string;
    state: "applied" | "stale" | "invalid";
    reason: string | null;
    contributionId: string | null;
    appliedAt: string;
  }): Promise<void> {
    const rawPath = layout.humanSignal(input.signalId);
    const procPath = layout.humanSignalProcessed(input.signalId);

    return this.store.withFileLock(procPath, async () => {
      const body = await this.store.readText(rawPath);
      if (body == null) {
        // Raw envelope may have been deleted; still write a stub processed
        // record so future drains do not re-process this id.
        const stub = HumanSignalRecord.parse({
          envelope: {
            signal_id: input.signalId,
            signal_type: "stop",
            target_kind: "system",
            target_id: "system",
            actor: "unknown",
            created_at: input.appliedAt,
            source: "fs_drop",
          },
          processing_state: input.state,
          applied_at: input.appliedAt,
          reason: input.reason ?? "envelope_missing_at_processing",
          contribution_id: input.contributionId,
        });
        await this.store.writeAtomic(procPath, JSON.stringify(stub, null, 2));
        return;
      }
      const env = HumanSignalEnvelope.parse(JSON.parse(body));
      const rec = HumanSignalRecord.parse({
        envelope: env,
        processing_state: input.state,
        applied_at: input.appliedAt,
        reason: input.reason,
        contribution_id: input.contributionId,
      });
      await this.store.writeAtomic(procPath, JSON.stringify(rec, null, 2));
    });
  }
}
