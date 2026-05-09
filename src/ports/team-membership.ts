/**
 * TCC-GOVERNANCE — Team membership lookup port (phase 9a, G2-4).
 *
 * Authority: `docs/contracts/target-config-contract.md#TCC-GOVERNANCE`
 * (`governance.human_team`) + RGC-SIGNALS Inv #5 (only members of the
 * declared human team can author bindable approve / reject / request_rework
 * signals).
 *
 * The port is intentionally narrow — adapters resolve the team identifier
 * to whatever scope they need (GitHub uses `<org>/<slug>`; the FS-mirror
 * adapter treats the team string as an opaque key into a deterministic
 * allowlist file). Callers MUST treat `unreachable` as distinct from
 * `non-member` — the binding hook follows the operator-declared policy
 * (warn vs block) for unreachable lookups.
 */

export type MembershipResult =
  /** Actor is a confirmed team member. */
  | { kind: "member" }
  /** Lookup completed and the actor is NOT a member. */
  | { kind: "non_member" }
  /**
   * Lookup could not complete (network, auth, 5xx, missing config).
   * The binding hook resolves the unreachable policy
   * (`actor_team_membership_unreachable` invariant) to decide warn vs block.
   * `detail` is logged but never user-facing.
   */
  | { kind: "unreachable"; detail: string };

export interface TeamMembershipPort {
  /**
   * Returns whether `actor` is a member of `team`.
   *
   * Adapters MAY cache positive results for a TTL window
   * (`governance.human_team_cache_ttl_seconds`). Negative / unreachable
   * results SHOULD be cached for a much shorter window or not at all so
   * newly-added members are picked up without operator intervention.
   *
   * The function MUST NOT throw on transport / auth errors — return
   * `unreachable` instead so the caller can apply the operator policy.
   * It MAY throw on programmer errors (empty `team` / `actor`).
   */
  isMember(team: string, actor: string): Promise<MembershipResult>;
}
