/**
 * Notifier port — push-only side-channel for human-facing announcements
 * (escalations, milestone done, slice blocked).
 *
 * RGC-NOTIFICATION is push-only — failures do not roll back the originating
 * operational write. Adapters log failure but do not throw to the caller's
 * success path.
 *
 * This port is intentionally minimal. State-bearing surfaces (milestone /
 * issue / PR bodies, labels) live on `IssueTrackerPort` / `GitHostPort`.
 */

export interface NotificationInput {
  /** Stable notification identifier — used for de-duplication (idempotency). */
  notificationId: string;
  /** Provider-routing target (e.g. issue ref, PR ref) as opaque string. */
  target: string;
  /** Notification body (markdown). */
  body: string;
  /** Optional severity hint. Adapters may render differently per level. */
  severity?: "info" | "warn" | "error";
}

export interface NotifierPort {
  notify(input: NotificationInput): Promise<{ delivered: boolean }>;
}
