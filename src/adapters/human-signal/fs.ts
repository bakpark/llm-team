/**
 * FS-channel adapter for RGC-SIGNALS.
 *
 * Layout:
 *   workdir/human_signals/<signal_id>.json            # raw envelope dropped by human
 *   workdir/human_signals/processed/<signal_id>.json  # post-processing record
 *   workdir/human_signals/quarantine/<filename>       # corrupt or filename-mismatched
 *
 * Atomic write (rename-after-write) is delegated to StorePort.writeAtomic /
 * StorePort.move — the same FsStore primitives that protect every other
 * persistent object.
 *
 * Idempotency invariants:
 *   1. processed/<id>.json existence ⇒ resolved (excluded from listPending).
 *   2. markProcessed re-reads processed/ inside its lock — concurrent drains
 *      cannot both record `applied` for the same signal_id.
 *   3. listPending validates filename ↔ envelope.signal_id consistency. A
 *      mismatch (foo.json containing {signal_id: "bar"}) would otherwise leave
 *      foo.json eternally pending after processed/bar.json is written; such
 *      files are atomically moved to quarantine/.
 *   4. Unparseable envelopes are also quarantined to prevent permanent pending.
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

      const rawPath = `human_signals/${name}`;
      const body = await this.store.readText(rawPath);
      if (body == null) continue;

      let env: HumanSignalEnvelope;
      try {
        env = HumanSignalEnvelope.parse(JSON.parse(body));
      } catch {
        // P1-4: corrupt envelope → quarantine so it doesn't pin the queue.
        await this.quarantine(rawPath, name);
        continue;
      }

      // P0-1: filename ↔ envelope.signal_id consistency. A mismatch would
      // mean processed/<env.signal_id>.json gets written but the original
      // file (named after a different id) stays pending forever.
      if (env.signal_id !== id) {
        await this.quarantine(rawPath, name);
        continue;
      }

      out.push(env);
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
  }): Promise<{ alreadyProcessed: boolean }> {
    const rawPath = layout.humanSignal(input.signalId);
    const procPath = layout.humanSignalProcessed(input.signalId);

    return this.store.withFileLock(procPath, async () => {
      // P0-2: re-check processed/ inside the lock so two parallel drains can
      // never both record `applied` for the same signal.
      const existing = await this.store.readText(procPath);
      if (existing != null) {
        return { alreadyProcessed: true } as const;
      }

      const body = await this.store.readText(rawPath);
      if (body == null) {
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
        return { alreadyProcessed: false } as const;
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
      return { alreadyProcessed: false } as const;
    });
  }

  private async quarantine(rawPath: string, filename: string): Promise<void> {
    const target = layout.humanSignalQuarantine(filename);
    try {
      await this.store.move(rawPath, target);
    } catch {
      // Another concurrent drain may have moved or processed it; that's
      // benign — both quarantine and processed paths terminate the file's
      // pending status.
    }
  }
}
