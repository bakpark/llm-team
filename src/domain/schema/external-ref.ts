import { z } from "zod";

export const ExternalRefKind = z.enum([
  "tracker",
  "review_surface",
  "milestone",
  "unknown",
]);
export type ExternalRefKind = z.infer<typeof ExternalRefKind>;

export const ExternalRef = z
  .object({
    provider: z.string().min(1),
    kind: ExternalRefKind,
    id: z.string().min(1),
    url: z.string().min(1).optional(),
    sync_status: z.enum(["clean", "dirty", "conflict", "unknown"]).optional(),
    last_synced_internal_revision: z.string().min(1).optional(),
    last_seen_external_revision: z.string().min(1).optional(),
  })
  .strict();

export type ExternalRef = z.infer<typeof ExternalRef>;
