/**
 * incident-1b Bug B — `resolveManifestEntries` walks a ContextManifest and
 * returns body-resolved entries for inlining under the prompt's `# Inputs`
 * section. This test fixes the supported (object_kind, fetch_scope) surface
 * to (`milestone`, `body`) and locks the failure modes for unsupported entries.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/store/memory.js";
import { resolveManifestEntries } from "../../src/application/manifest-resolve.js";
import { layout } from "../../src/application/persistence-layout.js";
import { ContextManifest } from "../../src/domain/schema/manifest.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const MANIFEST_ID = "01HZMA0000000000000000000A";
const MILESTONE_ID = "01HZMS0000000000000000000A";
const REQUEST_ID = "01HZFR0000000000000000000A";
const ISO = "2026-05-07T00:00:00.000Z";

function buildManifest(extraEntries: any[] = [], primaryRevisionPin = ISO) {
  return ContextManifest.parse({
    manifest_id: MANIFEST_ID,
    session_id: SESSION_ID,
    turn_index: 0,
    purpose: "design",
    target: { object_kind: "milestone", object_id: MILESTONE_ID },
    entries: [
      {
        object_kind: "milestone",
        object_id: MILESTONE_ID,
        fetch_scope: "body",
        revision_pin: primaryRevisionPin,
        required: true,
        purpose: "primary",
      },
      ...extraEntries,
    ],
    created_at: ISO,
  });
}

async function seedMilestone(store: MemoryStore, body: string) {
  const milestone = {
    milestone_id: MILESTONE_ID,
    target_id: "team-a",
    title: "Add ledger summary CLI",
    state: "M_INTAKE_QUEUED",
    slot_kind: null,
    intake_source_kind: "feature_request",
    intake_source_id: REQUEST_ID,
    spec_revision_pin: null,
    context_summary_id: null,
    external_refs: [],
    created_at: ISO,
    updated_at: ISO,
  };
  await store.writeAtomic(layout.milestone(MILESTONE_ID), JSON.stringify(milestone));
  const fr = {
    request_id: REQUEST_ID,
    title: "Add ledger summary CLI",
    body,
    submitted_by: "user@example.com",
    submitted_at: ISO,
    state: "queued",
    promoted_milestone_id: null,
    processed_at: null,
    rejection_reason: null,
  };
  await store.writeAtomic(layout.featureRequest(REQUEST_ID), JSON.stringify(fr));
}

describe("resolveManifestEntries", () => {
  it("resolves milestone body — title + intake feature_request body", async () => {
    const store = new MemoryStore();
    await seedMilestone(store, "operators want a ledger summary tool");
    const manifest = buildManifest();
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
    expect(resolved[0]!.body).toContain("Add ledger summary CLI");
    expect(resolved[0]!.body).toContain("operators want a ledger summary tool");
  });

  it("appends spec.md body when present", async () => {
    const store = new MemoryStore();
    await seedMilestone(store, "raw");
    await store.writeAtomic(
      layout.milestoneSpec(MILESTONE_ID),
      "# Spec\n\nProblem framing: …",
    );
    const resolved = await resolveManifestEntries(store, buildManifest());
    expect(resolved[0]!.body).toContain("spec.md:");
    expect(resolved[0]!.body).toContain("Problem framing");
  });

  it("throws on required milestone whose store object is missing (PR #93 P0-A)", async () => {
    const store = new MemoryStore();
    await expect(resolveManifestEntries(store, buildManifest())).rejects.toThrow(
      /required manifest entry not found/,
    );
  });

  it("skips non-required milestone entries silently when store object is missing", async () => {
    const store = new MemoryStore();
    const manifest = ContextManifest.parse({
      manifest_id: MANIFEST_ID,
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "design",
      target: { object_kind: "milestone", object_id: MILESTONE_ID },
      entries: [
        {
          object_kind: "milestone",
          object_id: MILESTONE_ID,
          fetch_scope: "body",
          revision_pin: ISO,
          required: false,
          purpose: "advisory",
        },
      ],
      created_at: ISO,
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(0);
  });

  it("throws on required milestone when revision_pin differs from store updated_at (PR #93 P0-B)", async () => {
    const store = new MemoryStore();
    await seedMilestone(store, "raw");
    const stalePin = "2025-01-01T00:00:00.000Z";
    await expect(
      resolveManifestEntries(store, buildManifest([], stalePin)),
    ).rejects.toThrow(/revision_pin mismatch/);
  });

  it("throws on required entries with unsupported (object_kind, fetch_scope)", async () => {
    const store = new MemoryStore();
    await seedMilestone(store, "raw");
    // incident-9 made `(slice, body)` supported, and incident-11 made
    // `(slice_merge, body)` and `(verification_run, body)` supported. Use
    // `(slice_telemetry, body)` here as a still-unsupported pair.
    const manifest = buildManifest([
      {
        object_kind: "slice_telemetry",
        object_id: "01HZTM0000000000000000000A",
        fetch_scope: "body",
        revision_pin: "deadbeef",
        required: true,
        purpose: "scope_violation_marker",
      },
    ]);
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /unsupported manifest entry/,
    );
  });

  it("silently skips non-required unsupported entries", async () => {
    const store = new MemoryStore();
    await seedMilestone(store, "raw");
    const manifest = buildManifest([
      {
        object_kind: "session_turn",
        object_id: `${SESSION_ID}#0`,
        fetch_scope: "body",
        revision_pin: "deadbeef",
        required: false,
        purpose: "prior turn",
      },
      {
        object_kind: "slice_telemetry",
        object_id: "01HZTM0000000000000000000A",
        fetch_scope: "body",
        revision_pin: "deadbeef",
        required: false,
        purpose: "telemetry",
      },
    ]);
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
  });
});

/**
 * incident-5 — `(session_turn, body)` resolver tests. Discovery atlas /
 * sentinel were stuck in `request_changes ↔ need_context` because
 * resolveManifestEntries silently dropped prior turn bodies. These tests
 * lock the new behaviour: body is read from
 * `sessions/<session_id>/turns/<n>.json`, projected to agent-relevant
 * envelope fields, with the same revision_pin / required-missing /
 * stale-pin failure modes as milestone body resolution.
 */
describe("resolveManifestEntries — session_turn body (incident-5)", () => {
  const TURN_SESSION_ID = "01HZSE000000000000000000T1";
  const PRIMARY_MILESTONE = "01HZMS00000000000000000T01";
  const PRIMARY_REQUEST = "01HZFR00000000000000000T01";
  const ENV_BASE_ISO = "2026-05-08T10:00:00.000Z";

  function seedTurn(index: number, summary: string) {
    const envelope = {
      session_id: TURN_SESSION_ID,
      turn_index: index,
      parent_loop: "outer",
      phase_or_purpose: "Discovery",
      slice_id: null,
      slice_kind: null,
      tdd_phase: null,
      agent_profile_id: index % 2 === 0 ? "atlas" : "sentinel",
      agent_role_in_session: index % 2 === 0 ? "lead" : "reviewer",
      contribution_kind: index % 2 === 0 ? "lead_draft" : "review_verdict",
      parent_review_verdict_id: null,
      output_kind: index % 2 === 0 ? "spec_proposal" : "verdict",
      object_id: PRIMARY_MILESTONE,
      manifest_id: "01HZMA00000000000000000T01",
      input_revision_pins: ["deadbeef"],
      summary,
      artifacts: null,
      verdict:
        index % 2 === 1
          ? {
              result: "request_changes",
              rationale: "needs scope sharpening",
            }
          : null,
      next_action_request: null,
      failure: null,
      idempotency_key: `idemp:${TURN_SESSION_ID}:${index}`,
      runtime_metadata: {},
    };
    const turn = {
      session_id: TURN_SESSION_ID,
      turn_index: index,
      agent_profile_id: envelope.agent_profile_id,
      input_manifest_id: "01HZMA00000000000000000T01",
      input_turn_log_snapshot_ref: null,
      output_envelope: envelope,
      next_action_request: null,
      caller_routing_decision: null,
      workspace_commit: null,
      verification_result_ref: null,
      recorded_at: ENV_BASE_ISO,
    };
    return JSON.stringify(turn);
  }

  function pinFor(raw: string): string {
    // PR #96 P0-1: full-body sha256 hex (replaces the previous
    // `len=N:<first 32 chars>` fingerprint).
    return createHash("sha256").update(raw).digest("hex");
  }

  async function seedPrimaryMilestone(store: MemoryStore) {
    await store.writeAtomic(
      layout.milestone(PRIMARY_MILESTONE),
      JSON.stringify({
        milestone_id: PRIMARY_MILESTONE,
        target_id: "team-a",
        title: "Discovery loop fix",
        state: "M_DISCOVERY_DRAFT",
        slot_kind: "discovery",
        intake_source_kind: "feature_request",
        intake_source_id: PRIMARY_REQUEST,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: ENV_BASE_ISO,
        updated_at: ENV_BASE_ISO,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(PRIMARY_REQUEST),
      JSON.stringify({
        request_id: PRIMARY_REQUEST,
        title: "Discovery loop fix",
        body: "raw scope text",
        submitted_by: "user@example.com",
        submitted_at: ENV_BASE_ISO,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
  }

  function manifestWithSessionTurn(extra: any) {
    return ContextManifest.parse({
      manifest_id: "01HZMA00000000000000000T01",
      session_id: TURN_SESSION_ID,
      turn_index: 4,
      purpose: "design",
      target: { object_kind: "milestone", object_id: PRIMARY_MILESTONE },
      entries: [
        {
          object_kind: "milestone",
          object_id: PRIMARY_MILESTONE,
          fetch_scope: "body",
          revision_pin: ENV_BASE_ISO,
          required: true,
          purpose: "primary",
        },
        extra,
      ],
      created_at: ENV_BASE_ISO,
    });
  }

  it("resolves required session_turn body via turn_index field", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const turnRaw = seedTurn(1, "reviewer flagged scope drift");
    await store.writeAtomic(layout.sessionTurn(TURN_SESSION_ID, 1), turnRaw);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 1,
      fetch_scope: "body",
      revision_pin: pinFor(turnRaw),
      required: true,
      purpose: "prior turn 1 (reviewer) (request_changes)",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    const turnEntry = resolved.find((r) => r.manifest_entry_index === 1)!;
    expect(turnEntry.body).toContain("reviewer flagged scope drift");
    expect(turnEntry.body).toContain("request_changes");
    expect(turnEntry.body).toContain("needs scope sharpening");
    // ULID guard — session_id projection must equal seed.
    expect(turnEntry.body).toContain(TURN_SESSION_ID);
    // Projection — top-level keys present.
    expect(turnEntry.body).toContain("\"summary\"");
    expect(turnEntry.body).toContain("\"verdict\"");
    expect(turnEntry.body).toContain("\"agent_role_in_session\"");
  });

  it("resolves session_turn body via legacy ${session_id}#${i} object_id", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const turnRaw = seedTurn(0, "lead initial draft");
    await store.writeAtomic(layout.sessionTurn(TURN_SESSION_ID, 0), turnRaw);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: `${TURN_SESSION_ID}#0`,
      fetch_scope: "body",
      revision_pin: pinFor(turnRaw),
      required: true,
      purpose: "prior turn 0 (lead)",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    expect(resolved[1]!.body).toContain("lead initial draft");
  });

  it("throws MissingRequiredManifestEntryError when turn file is absent and required", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 5,
      fetch_scope: "body",
      revision_pin: "len=0:",
      required: true,
      purpose: "missing prior turn",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /required manifest entry not found/,
    );
  });

  it("throws StaleManifestEntryError when revision_pin disagrees with stored body", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const turnRaw = seedTurn(2, "reviewer second pass");
    await store.writeAtomic(layout.sessionTurn(TURN_SESSION_ID, 2), turnRaw);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 2,
      fetch_scope: "body",
      revision_pin: "len=999:bogus",
      required: true,
      purpose: "stale prior turn",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /revision_pin mismatch/,
    );
  });

  it("PR #96 P1-A: projects only the agent-relevant subset (no input_manifest_id / runtime_metadata / idempotency_key leak)", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const turnRaw = seedTurn(1, "reviewer rationale text");
    await store.writeAtomic(layout.sessionTurn(TURN_SESSION_ID, 1), turnRaw);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 1,
      fetch_scope: "body",
      revision_pin: pinFor(turnRaw),
      required: true,
      purpose: "prior turn 1 (reviewer)",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    const turnEntry = resolved.find((r) => r.manifest_entry_index === 1)!;
    const body = turnEntry.body;
    // Selected (must be present).
    for (const key of [
      "session_id",
      "turn_index",
      "agent_profile_id",
      "agent_role_in_session",
      "output_kind",
      "contribution_kind",
      "summary",
      "verdict",
      "failure",
      "next_action_request",
    ]) {
      expect(body, `selected field ${key} missing`).toContain(`"${key}"`);
    }
    // Excluded (must NOT be present — the resolver projects an
    // agent-relevant subset, not the verbatim envelope/turn record).
    for (const key of [
      "input_manifest_id",
      "input_turn_log_snapshot_ref",
      "runtime_metadata",
      "idempotency_key",
      "input_revision_pins",
      "caller_routing_decision",
      "workspace_commit",
      "verification_result_ref",
      "recorded_at",
      "output_envelope",
      "parent_loop",
      "phase_or_purpose",
      "object_id",
      "manifest_id",
      "artifacts",
      "parent_review_verdict_id",
      "tdd_phase",
    ]) {
      expect(body, `excluded field ${key} leaked`).not.toContain(`"${key}"`);
    }
  });

  it("PR #96 P0-1 regression: equal-length post-prefix mutation (verdict.rationale) trips StaleManifestEntryError", async () => {
    // Build two raws with identical length but a single-char difference deep
    // in the body (verdict.rationale). The previous `len=N:<first 32 chars>`
    // pin format would not distinguish them when the prefix is unchanged.
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const baseRaw = seedTurn(1, "reviewer flagged scope drift");
    // Replace one character in `rationale` (preserves length).
    const mutatedRaw = baseRaw.replace(
      "needs scope sharpening",
      "needs scope sharpeninG",
    );
    expect(mutatedRaw.length).toBe(baseRaw.length);
    expect(mutatedRaw).not.toBe(baseRaw);
    // Pin computed from baseRaw, but stored body is mutatedRaw.
    await store.writeAtomic(layout.sessionTurn(TURN_SESSION_ID, 1), mutatedRaw);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 1,
      fetch_scope: "body",
      revision_pin: pinFor(baseRaw),
      required: true,
      purpose: "prior turn 1 (reviewer) (request_changes)",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /revision_pin mismatch/,
    );
  });

  it("silently skips non-required session_turn body when file is absent", async () => {
    const store = new MemoryStore();
    await seedPrimaryMilestone(store);
    const manifest = manifestWithSessionTurn({
      object_kind: "session_turn",
      object_id: TURN_SESSION_ID,
      turn_index: 7,
      fetch_scope: "body",
      revision_pin: "len=0:",
      required: false,
      purpose: "advisory prior turn",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    // Only the milestone entry survives.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
  });
});

/**
 * incident-9 — `(slice, body)` resolver tests. The inner TDD `forge` agent
 * was stuck in `failure: need_context` for 29+ turns because the
 * `(slice, body)` manifest entry rendered as `[BODY NOT INLINED]` in the
 * prompt. These tests lock the new behaviour: body is read from
 * `slices/<slice_id>.json`, projected to agent-relevant Slice fields, with
 * the same revision_pin / required-missing / stale-pin failure modes as
 * milestone / session_turn body resolution. Pin equality is matched
 * against `slice.dod_revision_pin` (logical marker, not content hash).
 */
describe("resolveManifestEntries — slice body (incident-9)", () => {
  const SLICE_SESSION_ID = "01HZSE000000000000000000S1";
  const SLICE_PRIMARY_MS = "01HZMS00000000000000000S02";
  const SLICE_PRIMARY_FR = "01HZFR00000000000000000S02";
  const SLICE_ID = "01HZSC000000000000000000S2";
  const SLICE_ISO = "2026-05-09T08:00:00.000Z";
  const DOD_PIN = "selfhost-dod-v1";

  function buildSlice(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      slice_id: SLICE_ID,
      milestone_id: SLICE_PRIMARY_MS,
      slice_kind: "internal",
      value_statement: "Discovery loop fix — inline session_turn body",
      ac_ids: ["AC-1", "AC-2"],
      acceptance_tests: [
        { path: "tests/x.test.ts", name: "loop converges", ac_id: "AC-1" },
      ],
      declared_scope: ["src/application/manifest-resolve.ts"],
      declared_metric_threshold: null,
      interface_break: false,
      dependencies: [],
      trunk_base_revision: "trunk-abc123",
      dod_revision_pin: DOD_PIN,
      state: "SLICE_BUILDING",
      current_session_id: SLICE_SESSION_ID,
      spawning_proposal_id: null,
      abandoned_reason: null,
      external_refs: [],
      created_at: SLICE_ISO,
      updated_at: SLICE_ISO,
      ...overrides,
    };
  }

  async function seedSliceMilestone(store: MemoryStore) {
    await store.writeAtomic(
      layout.milestone(SLICE_PRIMARY_MS),
      JSON.stringify({
        milestone_id: SLICE_PRIMARY_MS,
        target_id: "team-a",
        title: "Inner TDD slice resolution",
        state: "M_DELIVERY_BUILDING",
        slot_kind: "delivery",
        intake_source_kind: "feature_request",
        intake_source_id: SLICE_PRIMARY_FR,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: SLICE_ISO,
        updated_at: SLICE_ISO,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(SLICE_PRIMARY_FR),
      JSON.stringify({
        request_id: SLICE_PRIMARY_FR,
        title: "Inner TDD slice resolution",
        body: "raw scope text",
        submitted_by: "user@example.com",
        submitted_at: SLICE_ISO,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
  }

  function manifestWithSlice(extra: any) {
    return ContextManifest.parse({
      manifest_id: "01HZMA00000000000000000S01",
      session_id: SLICE_SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      entries: [
        {
          object_kind: "milestone",
          object_id: SLICE_PRIMARY_MS,
          fetch_scope: "body",
          revision_pin: SLICE_ISO,
          required: true,
          purpose: "primary",
        },
        extra,
      ],
      created_at: SLICE_ISO,
    });
  }

  it("resolves required slice body — projects agent-relevant Slice subset", async () => {
    const store = new MemoryStore();
    await seedSliceMilestone(store);
    await store.writeAtomic(
      layout.slice(SLICE_ID),
      JSON.stringify(buildSlice()),
    );
    const manifest = manifestWithSlice({
      object_kind: "slice",
      object_id: SLICE_ID,
      fetch_scope: "body",
      revision_pin: DOD_PIN,
      required: true,
      purpose: "primary input",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    const sliceEntry = resolved.find((r) => r.manifest_entry_index === 1)!;
    const body = sliceEntry.body;
    // Selected fields must appear.
    for (const key of [
      "slice_id",
      "slice_kind",
      "value_statement",
      "ac_ids",
      "acceptance_tests",
      "declared_scope",
      "dependencies",
      "state",
      "dod_revision_pin",
      "trunk_base_revision",
    ]) {
      expect(body, `selected field ${key} missing`).toContain(`"${key}"`);
    }
    expect(body).toContain(SLICE_ID);
    expect(body).toContain(DOD_PIN);
    expect(body).toContain("Discovery loop fix");
    expect(body).toContain("trunk-abc123");
    // Excluded fields (caller/lease metadata, timestamps).
    for (const key of [
      "current_session_id",
      "spawning_proposal_id",
      "abandoned_reason",
      "external_refs",
      "created_at",
      "updated_at",
      "milestone_id",
      "interface_break",
      "declared_metric_threshold",
    ]) {
      expect(body, `excluded field ${key} leaked`).not.toContain(`"${key}"`);
    }
  });

  it("throws MissingRequiredManifestEntryError when slice file is absent and required", async () => {
    const store = new MemoryStore();
    await seedSliceMilestone(store);
    const manifest = manifestWithSlice({
      object_kind: "slice",
      object_id: SLICE_ID,
      fetch_scope: "body",
      revision_pin: DOD_PIN,
      required: true,
      purpose: "primary input",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /required manifest entry not found/,
    );
  });

  it("throws StaleManifestEntryError when revision_pin differs from slice.dod_revision_pin", async () => {
    const store = new MemoryStore();
    await seedSliceMilestone(store);
    await store.writeAtomic(
      layout.slice(SLICE_ID),
      JSON.stringify(buildSlice({ dod_revision_pin: "selfhost-dod-v2" })),
    );
    const manifest = manifestWithSlice({
      object_kind: "slice",
      object_id: SLICE_ID,
      fetch_scope: "body",
      revision_pin: DOD_PIN,
      required: true,
      purpose: "primary input",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /revision_pin mismatch/,
    );
  });

  it("silently skips non-required slice body when file is absent", async () => {
    const store = new MemoryStore();
    await seedSliceMilestone(store);
    const manifest = manifestWithSlice({
      object_kind: "slice",
      object_id: SLICE_ID,
      fetch_scope: "body",
      revision_pin: DOD_PIN,
      required: false,
      purpose: "advisory slice",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    // Only the milestone entry survives.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
  });
});

/**
 * incident-11 — `(slice_merge, body)` and `(verification_run, body)`
 * resolver tests. Middle review sentinel (turn 10) was emitting
 * `failure: need_context` because both entries rendered as
 * `[BODY NOT INLINED]`. PR #108 covered (slice, body); this PR completes
 * the manifest declared by `dialogueReviewTurn` in dialogue-coordinator.ts.
 *
 * Pin format mirrors `MiddleReviewPinResolver`:
 *   - slice_merge → `pre_merge_workspace_revision ?? slice_merge_id`
 *   - verification_run → `entry.object_id` (immutable evidence id)
 */
describe("resolveManifestEntries — slice_merge body (incident-11)", () => {
  const SM_SESSION_ID = "01HZSE000000000000000000M1";
  const SM_PRIMARY_MS = "01HZMS00000000000000000M02";
  const SM_PRIMARY_FR = "01HZFR00000000000000000M02";
  const SM_SLICE_ID = "01HZSC000000000000000000M2";
  const SM_ID = "01HZSM000000000000000000M3";
  const SM_INNER_SESSION = "01HZSE000000000000000000M2";
  const SM_REVIEW_SESSION = "01HZSE000000000000000000M3";
  const SM_VERIF_ID = "01HZVR000000000000000000M4";
  const SM_ISO = "2026-05-09T09:00:00.000Z";
  const SM_PRE_MERGE_REV = "trunk-pre-merge-deadbeef";

  function buildSliceMerge(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      slice_merge_id: SM_ID,
      slice_id: SM_SLICE_ID,
      target_id: "team-a",
      pre_merge_workspace_revision: SM_PRE_MERGE_REV,
      merge_revision: null,
      inner_session_id: SM_INNER_SESSION,
      review_session_id: SM_REVIEW_SESSION,
      verification_run_id: SM_VERIF_ID,
      state: "SM_READY_FOR_REVIEW",
      merged_at: null,
      merged_by_caller_id: null,
      lease_token: "lease-secret-do-not-leak",
      audit_chain_predecessor_id: null,
      external_refs: [],
      created_at: SM_ISO,
      updated_at: SM_ISO,
      ...overrides,
    };
  }

  async function seedSmMilestone(store: MemoryStore) {
    await store.writeAtomic(
      layout.milestone(SM_PRIMARY_MS),
      JSON.stringify({
        milestone_id: SM_PRIMARY_MS,
        target_id: "team-a",
        title: "Middle review fix",
        state: "M_DELIVERY_BUILDING",
        slot_kind: "delivery",
        intake_source_kind: "feature_request",
        intake_source_id: SM_PRIMARY_FR,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: SM_ISO,
        updated_at: SM_ISO,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(SM_PRIMARY_FR),
      JSON.stringify({
        request_id: SM_PRIMARY_FR,
        title: "Middle review fix",
        body: "raw scope",
        submitted_by: "user@example.com",
        submitted_at: SM_ISO,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
  }

  function manifestWithSliceMerge(extra: any) {
    return ContextManifest.parse({
      manifest_id: "01HZMA00000000000000000M01",
      session_id: SM_SESSION_ID,
      turn_index: 0,
      purpose: "review",
      target: { object_kind: "slice_merge", object_id: SM_ID },
      entries: [
        {
          object_kind: "milestone",
          object_id: SM_PRIMARY_MS,
          fetch_scope: "body",
          revision_pin: SM_ISO,
          required: true,
          purpose: "primary",
        },
        extra,
      ],
      created_at: SM_ISO,
    });
  }

  it("resolves required slice_merge body — projects review-relevant subset", async () => {
    const store = new MemoryStore();
    await seedSmMilestone(store);
    await store.writeAtomic(
      layout.sliceMerge(SM_ID),
      JSON.stringify(buildSliceMerge()),
    );
    const manifest = manifestWithSliceMerge({
      object_kind: "slice_merge",
      object_id: SM_ID,
      fetch_scope: "body",
      revision_pin: SM_PRE_MERGE_REV,
      required: true,
      purpose: "review subject",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    const smEntry = resolved.find((r) => r.manifest_entry_index === 1)!;
    const body = smEntry.body;
    for (const key of [
      "slice_merge_id",
      "slice_id",
      "target_id",
      "state",
      "pre_merge_workspace_revision",
      "merge_revision",
      "inner_session_id",
      "review_session_id",
      "verification_run_id",
    ]) {
      expect(body, `selected field ${key} missing`).toContain(`"${key}"`);
    }
    expect(body).toContain(SM_ID);
    expect(body).toContain(SM_PRE_MERGE_REV);
    expect(body).toContain("SM_READY_FOR_REVIEW");
    // Lease/audit metadata must NOT leak.
    for (const key of [
      "lease_token",
      "merged_by_caller_id",
      "audit_chain_predecessor_id",
      "external_refs",
      "created_at",
      "updated_at",
    ]) {
      expect(body, `excluded field ${key} leaked`).not.toContain(`"${key}"`);
    }
    expect(body).not.toContain("lease-secret-do-not-leak");
  });

  it("falls back to slice_merge_id as pin when pre_merge_workspace_revision is null", async () => {
    const store = new MemoryStore();
    await seedSmMilestone(store);
    await store.writeAtomic(
      layout.sliceMerge(SM_ID),
      JSON.stringify(buildSliceMerge({ pre_merge_workspace_revision: null })),
    );
    const manifest = manifestWithSliceMerge({
      object_kind: "slice_merge",
      object_id: SM_ID,
      fetch_scope: "body",
      revision_pin: SM_ID,
      required: true,
      purpose: "review subject",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
  });

  it("throws MissingRequiredManifestEntryError when slice_merge file is absent", async () => {
    const store = new MemoryStore();
    await seedSmMilestone(store);
    const manifest = manifestWithSliceMerge({
      object_kind: "slice_merge",
      object_id: SM_ID,
      fetch_scope: "body",
      revision_pin: SM_PRE_MERGE_REV,
      required: true,
      purpose: "review subject",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /required manifest entry not found/,
    );
  });

  it("throws StaleManifestEntryError when revision_pin disagrees with stored slice_merge pin", async () => {
    const store = new MemoryStore();
    await seedSmMilestone(store);
    await store.writeAtomic(
      layout.sliceMerge(SM_ID),
      JSON.stringify(buildSliceMerge({ pre_merge_workspace_revision: "trunk-other" })),
    );
    const manifest = manifestWithSliceMerge({
      object_kind: "slice_merge",
      object_id: SM_ID,
      fetch_scope: "body",
      revision_pin: SM_PRE_MERGE_REV,
      required: true,
      purpose: "review subject",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /revision_pin mismatch/,
    );
  });

  it("silently skips non-required slice_merge body when file is absent", async () => {
    const store = new MemoryStore();
    await seedSmMilestone(store);
    const manifest = manifestWithSliceMerge({
      object_kind: "slice_merge",
      object_id: SM_ID,
      fetch_scope: "body",
      revision_pin: SM_PRE_MERGE_REV,
      required: false,
      purpose: "advisory",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
  });
});

describe("resolveManifestEntries — verification_run body (incident-11)", () => {
  const VR_SESSION_ID = "01HZSE000000000000000000V1";
  const VR_PRIMARY_MS = "01HZMS00000000000000000V02";
  const VR_PRIMARY_FR = "01HZFR00000000000000000V02";
  const VR_ID = "01HZVR000000000000000000V3";
  const VR_ISO = "2026-05-09T10:00:00.000Z";

  function buildRun(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      verification_run_id: VR_ID,
      target_id: "team-a",
      target_revision: "trunk-after-merge-cafe",
      commands_or_checks: ["npm run typecheck", "npm run test"],
      environment_fingerprint: "node-20-darwin-arm64",
      started_at: VR_ISO,
      finished_at: VR_ISO,
      result: "fail",
      failed_tests: [
        { path: "tests/x.test.ts", name: "loop converges", message: "expected 2 got 3" },
      ],
      log_ref: "verifications/01HZVR000000000000000000V3.log",
      covers_ac_ids: ["AC-1", "AC-2"],
      ...overrides,
    };
  }

  async function seedVrMilestone(store: MemoryStore) {
    await store.writeAtomic(
      layout.milestone(VR_PRIMARY_MS),
      JSON.stringify({
        milestone_id: VR_PRIMARY_MS,
        target_id: "team-a",
        title: "Verification body inline",
        state: "M_DELIVERY_BUILDING",
        slot_kind: "delivery",
        intake_source_kind: "feature_request",
        intake_source_id: VR_PRIMARY_FR,
        spec_revision_pin: null,
        context_summary_id: null,
        external_refs: [],
        created_at: VR_ISO,
        updated_at: VR_ISO,
      }),
    );
    await store.writeAtomic(
      layout.featureRequest(VR_PRIMARY_FR),
      JSON.stringify({
        request_id: VR_PRIMARY_FR,
        title: "Verification body inline",
        body: "raw scope",
        submitted_by: "user@example.com",
        submitted_at: VR_ISO,
        state: "queued",
        promoted_milestone_id: null,
        processed_at: null,
        rejection_reason: null,
      }),
    );
  }

  function manifestWithRun(extra: any) {
    return ContextManifest.parse({
      manifest_id: "01HZMA00000000000000000V01",
      session_id: VR_SESSION_ID,
      turn_index: 0,
      purpose: "review",
      target: { object_kind: "milestone", object_id: VR_PRIMARY_MS },
      entries: [
        {
          object_kind: "milestone",
          object_id: VR_PRIMARY_MS,
          fetch_scope: "body",
          revision_pin: VR_ISO,
          required: true,
          purpose: "primary",
        },
        extra,
      ],
      created_at: VR_ISO,
    });
  }

  it("resolves required verification_run body — projects evidence subset", async () => {
    const store = new MemoryStore();
    await seedVrMilestone(store);
    await store.writeAtomic(
      layout.verification(VR_ID),
      JSON.stringify(buildRun()),
    );
    const manifest = manifestWithRun({
      object_kind: "verification_run",
      object_id: VR_ID,
      fetch_scope: "body",
      revision_pin: VR_ID,
      required: true,
      purpose: "evidence",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(2);
    const vrEntry = resolved.find((r) => r.manifest_entry_index === 1)!;
    const body = vrEntry.body;
    for (const key of [
      "verification_run_id",
      "target_id",
      "target_revision",
      "commands_or_checks",
      "result",
      "failed_tests",
      "covers_ac_ids",
      "log_ref",
    ]) {
      expect(body, `selected field ${key} missing`).toContain(`"${key}"`);
    }
    expect(body).toContain(VR_ID);
    expect(body).toContain("loop converges");
    expect(body).toContain("\"fail\"");
    // environment_fingerprint / timestamps not relevant to reviewer.
    for (const key of [
      "environment_fingerprint",
      "started_at",
      "finished_at",
    ]) {
      expect(body, `excluded field ${key} leaked`).not.toContain(`"${key}"`);
    }
  });

  it("throws MissingRequiredManifestEntryError when verification file is absent", async () => {
    const store = new MemoryStore();
    await seedVrMilestone(store);
    const manifest = manifestWithRun({
      object_kind: "verification_run",
      object_id: VR_ID,
      fetch_scope: "body",
      revision_pin: VR_ID,
      required: true,
      purpose: "evidence",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /required manifest entry not found/,
    );
  });

  it("throws StaleManifestEntryError when revision_pin differs from verification_run_id", async () => {
    const store = new MemoryStore();
    await seedVrMilestone(store);
    await store.writeAtomic(
      layout.verification(VR_ID),
      JSON.stringify(buildRun()),
    );
    const manifest = manifestWithRun({
      object_kind: "verification_run",
      object_id: VR_ID,
      fetch_scope: "body",
      revision_pin: "01HZVR000000000000000000XX",
      required: true,
      purpose: "evidence",
    });
    await expect(resolveManifestEntries(store, manifest)).rejects.toThrow(
      /revision_pin mismatch/,
    );
  });

  it("silently skips non-required verification_run body when file is absent", async () => {
    const store = new MemoryStore();
    await seedVrMilestone(store);
    const manifest = manifestWithRun({
      object_kind: "verification_run",
      object_id: VR_ID,
      fetch_scope: "body",
      revision_pin: VR_ID,
      required: false,
      purpose: "advisory evidence",
    });
    const resolved = await resolveManifestEntries(store, manifest);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest_entry_index).toBe(0);
  });
});
