/**
 * Issue tracker port — abstracts the milestone/issue/PR/label surface so
 * application modules call the same API regardless of provider (`github`,
 * `fs-mirror`, future GitLab/Forgejo).
 *
 * Cardinality and state mappings are authoritative in
 * `docs/architecture/external-tracking-mapping.md` (§1, §3, §4).
 *
 * Side-effect ordering is authoritative in
 * `docs/architecture/github-side-effect-timeline.md` (§2).
 *
 * The port intentionally stays GitHub-agnostic: it neither models PR review
 * threads as a separate object (they share the PR surface) nor exposes
 * native review verdicts. Inbound human signals enter through
 * `HumanSignalPort` (RGC-SIGNALS) and never through this port.
 *
 * All write operations are caller-side (Inv #4 caller_only_operational_write).
 */

export interface ExternalRefHandle {
  /** Provider id, e.g. `"github"` or `"fs-mirror"`. */
  provider: string;
  /** Provider-local identifier (issue number, milestone number, PR number). */
  id: string;
  /** Optional public URL. */
  url?: string;
}

export type IssueTrackerKind =
  | "tracker"
  | "milestone_tracker"
  | "control"
  | "contract_change";

export interface CreateMilestoneInput {
  title: string;
  /** Optional state label, e.g. `state/M_DELIVERY_BUILDING`. */
  stateLabel?: string;
  /** Optional slot label (`slot/discovery` | `slot/delivery`). */
  slotLabel?: string;
  /** Optional description body (`AGC-ISSUE-BODY` machine block). */
  body?: string;
}

export interface UpdateMilestoneStateInput {
  milestoneRef: ExternalRefHandle;
  /** New full set of `state/*` and `slot/*` labels (replace semantics). */
  labels: string[];
  /** Optional new title. */
  title?: string;
  /** Optional new body (full replacement). */
  body?: string;
}

export interface CreateIssueInput {
  kind: IssueTrackerKind;
  title: string;
  body: string;
  labels: string[];
  /** Optional milestone ref to link the issue under. */
  milestoneRef?: ExternalRefHandle;
}

export interface UpdateIssueInput {
  issueRef: ExternalRefHandle;
  /** Replace label set. */
  labels: string[];
  /** Optional title replacement. */
  title?: string;
  /** Optional body replacement. */
  body?: string;
  /** Optional close/reopen. */
  state?: "open" | "closed";
}

export interface IssueTrackerPort {
  createMilestone(input: CreateMilestoneInput): Promise<ExternalRefHandle>;
  updateMilestoneState(
    input: UpdateMilestoneStateInput,
  ): Promise<ExternalRefHandle>;

  createIssue(input: CreateIssueInput): Promise<ExternalRefHandle>;
  updateIssue(input: UpdateIssueInput): Promise<ExternalRefHandle>;

  /**
   * Best-effort read of the current external state for drift detection.
   * Adapters return `null` when the surface no longer exists (orphan).
   */
  fetchIssue(
    issueRef: ExternalRefHandle,
  ): Promise<{
    state: "open" | "closed";
    labels: string[];
    title: string;
    body: string;
    revision: string;
  } | null>;
  fetchMilestone(
    milestoneRef: ExternalRefHandle,
  ): Promise<{
    labels: string[];
    title: string;
    body: string;
    revision: string;
  } | null>;
}
