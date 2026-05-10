/**
 * incident-1b Bug B — `resolveManifestEntries` walks a ContextManifest and
 * returns body-resolved entries for inlining under the prompt's `# Inputs`
 * section. This test fixes the supported (object_kind, fetch_scope) surface
 * to (`milestone`, `body`) and locks the failure modes for unsupported entries.
 */
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
    const manifest = buildManifest([
      {
        object_kind: "slice",
        object_id: "01HZS00000000000000000000A",
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
