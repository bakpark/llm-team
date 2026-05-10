import { z } from "zod";

/**
 * LeadIntent — narrow contract a lead agent emits as fenced JSON.
 *
 * Authority: `cli-spicy-anchor.md` §5, §8.
 *
 * `changed_files` is the post-call tracked-diff allowlist input (L4): the
 * Caller compares the worktree's tracked diff with this list. Any tracked
 * diff outside `changed_files` triggers `capability_violation_l4_diff`.
 */

export const LeadIntent = z
  .object({
    summary: z.string().min(1),
    /** Repo-relative paths the lead claims to have written. */
    changed_files: z.array(z.string().min(1)).default(() => []),
    decision_needed: z.string().default(""),
    verification_notes: z.string().default(""),
    open_questions: z.string().default(""),
  })
  .strict();
export type LeadIntent = z.infer<typeof LeadIntent>;
