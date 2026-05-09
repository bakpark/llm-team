import { z } from "zod";

/**
 * RGC-SIGNALS — daemon control state record (Phase 7b).
 *
 * Persisted at `<workdir>/control/state.json`. A single record records the
 * most recent `pause` / `resume` / `stop` transition; daemons read it as the
 * authoritative gate before every pickup.
 *
 * State machine:
 *   RUNNING --pause--> PAUSED
 *   PAUSED  --resume--> RUNNING
 *   RUNNING|PAUSED --stop--> STOPPED  (terminal — no further transitions)
 *
 * `signal_id` is the human signal envelope that produced the transition. The
 * sentinel `system:default` is used by the implicit RUNNING default that
 * exists before any signal has fired.
 */
export const ControlState = z.enum(["RUNNING", "PAUSED", "STOPPED"]);
export type ControlState = z.infer<typeof ControlState>;

export const ControlStateRecord = z
  .object({
    state: ControlState,
    changed_at: z.string().datetime(),
    changed_by: z.string().min(1),
    signal_id: z.string().min(1),
  })
  .strict();
export type ControlStateRecord = z.infer<typeof ControlStateRecord>;
