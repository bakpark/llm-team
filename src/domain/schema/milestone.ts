import { z } from "zod";
import { UlidString } from "../ids.js";
import { ExternalRef } from "./external-ref.js";

export const MilestoneState = z.enum([
  "M_INTAKE_QUEUED",
  "M_DISCOVERY_DRAFT",
  "M_DISCOVERY_AWAITING_HUMAN",
  "M_SPECIFICATION_DRAFT",
  "M_SPECIFICATION_AWAITING_HUMAN",
  "M_SPEC_APPROVED",
  "M_DELIVERY_PLANNING",
  "M_DELIVERY_BUILDING",
  "M_DELIVERY_VALIDATING",
  "M_DONE",
  "M_ESCALATED",
]);
export type MilestoneState = z.infer<typeof MilestoneState>;

export const SlotKind = z.enum(["discovery", "delivery"]);
export type SlotKind = z.infer<typeof SlotKind>;

export const Milestone = z
  .object({
    milestone_id: UlidString,
    target_id: z.string().min(1),
    title: z.string().min(1),
    state: MilestoneState,
    slot_kind: SlotKind.nullable(),
    intake_source_kind: z.string().min(1),
    intake_source_id: z.string().min(1),
    spec_revision_pin: z.string().min(1).nullable(),
    context_summary_id: UlidString.nullable(),
    external_refs: z.array(ExternalRef).default(() => []),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type Milestone = z.infer<typeof Milestone>;
