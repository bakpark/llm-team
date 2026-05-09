/**
 * FS-mirror NotifierPort — collects notifications under
 * `workdir/external_mirror/notifications.ndjson`. Used by tests and
 * self-hosting mode.
 *
 * Idempotency: notifications with the same `notification_id` are skipped on
 * the second call, so the port stays push-only without retry duplication.
 */

import type {
  NotificationInput,
  NotifierPort,
} from "../../ports/notifier.js";
import type { StorePort } from "../../ports/store.js";

const PATH = "external_mirror/notifications.ndjson";
const SEEN_PATH = "external_mirror/_notifications_seen.json";

export class FsMirrorNotifier implements NotifierPort {
  static readonly provider = "fs-mirror";

  constructor(private readonly store: StorePort) {}

  async notify(
    input: NotificationInput,
  ): Promise<{ delivered: boolean }> {
    return this.store.withFileLock(SEEN_PATH, async () => {
      const raw = await this.store.readText(SEEN_PATH);
      const seen: Record<string, true> =
        raw == null ? {} : (JSON.parse(raw) as Record<string, true>);
      if (seen[input.notificationId]) {
        return { delivered: false };
      }
      seen[input.notificationId] = true;
      await this.store.writeAtomic(SEEN_PATH, JSON.stringify(seen));
      const line = JSON.stringify({
        notification_id: input.notificationId,
        target: input.target,
        body: input.body,
        severity: input.severity ?? "info",
      });
      await this.store.appendLine(PATH, line);
      return { delivered: true };
    });
  }
}
