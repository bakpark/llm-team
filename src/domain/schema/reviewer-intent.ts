import { z } from "zod";

/**
 * ReviewerIntent — narrow contract a reviewer agent emits as fenced JSON.
 *
 * Authority: `cli-spicy-anchor.md` §5, §8.
 */

export const ReviewerIntentVerdict = z.enum(["approve", "request_changes"]);
export type ReviewerIntentVerdict = z.infer<typeof ReviewerIntentVerdict>;

export const ReviewerFileComment = z
  .object({
    /** Repo-relative path. */
    path: z.string().min(1),
    /** Line number on the right-side diff (1-indexed). */
    line: z.number().int().positive(),
    /** Optional starting line for multi-line comments. */
    start_line: z.number().int().positive().nullable().default(null),
    body: z.string().min(1),
  })
  .strict();
export type ReviewerFileComment = z.infer<typeof ReviewerFileComment>;

export const ReviewerIntent = z
  .object({
    intent: ReviewerIntentVerdict,
    body: z.string().default(""),
    file_comments: z.array(ReviewerFileComment).default(() => []),
  })
  .strict();
export type ReviewerIntent = z.infer<typeof ReviewerIntent>;
