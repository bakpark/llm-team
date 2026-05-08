/**
 * Lease heartbeat — periodic renewal during long-running work.
 *
 * PR #64 review P0-1: a session_lease / slice_lease with TTL=60s cannot
 * survive a 120s `callAgent` invocation. Without renewal the recovery
 * sweep would reach the lease before the work finishes, roll the slice /
 * session back, and silently overwrite the live worker's output.
 *
 * `withLeaseHeartbeat` wraps a Promise-returning function and runs a
 * `setInterval` that calls `lease.renew()` every `intervalMs`. The interval
 * defaults to `ttlMs / 3` so the lease is refreshed twice before it would
 * have expired (covers a single missed renewal).
 *
 * If `renew()` returns `renewed=false` the lease has been hijacked or
 * recovered already. We mark `lost=true` on the returned status and stop
 * issuing further renewals — the wrapped function may inspect `getStatus()`
 * to decide whether to abort. The function is NOT cancelled by the helper
 * (cancelling an in-flight LLM call from outside is unsafe); the caller
 * remains responsible for any abort logic.
 */
import type { LeasePort } from "../ports/lease.js";

export interface HeartbeatStatus {
  lost: boolean;
  lostReason: string | null;
  renewals: number;
}

export interface HeartbeatHandle {
  status: HeartbeatStatus;
  stop(): Promise<void>;
}

export interface StartHeartbeatInput {
  lease: LeasePort;
  leaseId: string;
  leaseToken: string;
  ttlMs: number;
  /** Override the default `ttlMs / 3` interval. */
  intervalMs?: number;
  /** Optional listener for telemetry. */
  onRenewal?: (renewed: boolean) => void;
}

export function startLeaseHeartbeat(input: StartHeartbeatInput): HeartbeatHandle {
  const status: HeartbeatStatus = {
    lost: false,
    lostReason: null,
    renewals: 0,
  };
  const interval = Math.max(1, Math.floor((input.intervalMs ?? input.ttlMs) / 3));
  let timer: NodeJS.Timeout | null = setInterval(async () => {
    if (status.lost) return;
    try {
      const out = await input.lease.renew({
        leaseId: input.leaseId,
        leaseToken: input.leaseToken,
        newTtlMs: input.ttlMs,
      });
      status.renewals += 1;
      if (!out.renewed) {
        status.lost = true;
        status.lostReason = "renew rejected (token mismatch / expired / released)";
        if (timer != null) {
          clearInterval(timer);
          timer = null;
        }
      }
      input.onRenewal?.(out.renewed);
    } catch (err) {
      status.lost = true;
      status.lostReason = `renew error: ${(err as Error).message}`;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    }
  }, interval);
  // Keep timer from holding the event loop open — daemon shutdown should
  // exit promptly. Tests use FixedClock + manual ticks so this matters
  // less in unit-test contexts.
  timer.unref();

  return {
    status,
    async stop(): Promise<void> {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Convenience wrapper: start the heartbeat, run the work, stop the
 * heartbeat in finally. Returns both the work result and the final
 * heartbeat status so the caller can decide whether to act on a lost
 * lease (e.g. emit an extra ledger row).
 */
export async function withLeaseHeartbeat<T>(
  input: StartHeartbeatInput,
  fn: (status: HeartbeatStatus) => Promise<T>,
): Promise<{ value: T; status: HeartbeatStatus }> {
  const handle = startLeaseHeartbeat(input);
  try {
    const value = await fn(handle.status);
    return { value, status: handle.status };
  } finally {
    await handle.stop();
  }
}
