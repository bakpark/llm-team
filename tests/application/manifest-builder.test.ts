import { describe, expect, it } from "vitest";
import {
  ManifestBuilder,
  type ManifestEntryDraft,
  type RevisionPinResolver,
} from "../../src/application/manifest-builder.js";
import { isUlid } from "../../src/domain/ids.js";
import { FixedClock } from "../../src/ports/clock.js";

const SESSION_ID = "01HZSE0000000000000000000A";
const SLICE_ID = "01HZS00000000000000000000A";

class StaticResolver implements RevisionPinResolver {
  constructor(private readonly pins: Map<string, string>) {}

  async resolve(d: ManifestEntryDraft): Promise<string> {
    const k = key(d);
    const p = this.pins.get(k);
    if (p == null) throw new Error(`no pin for ${k}`);
    return p;
  }

  set(d: ManifestEntryDraft, pin: string): void {
    this.pins.set(key(d), pin);
  }
}

function key(d: ManifestEntryDraft): string {
  return `${d.object_kind}:${d.object_id}`;
}

describe("ManifestBuilder.build", () => {
  it("resolves revision pins for each draft and emits a ULID manifest_id", async () => {
    const drafts: ManifestEntryDraft[] = [
      {
        object_kind: "slice",
        object_id: SLICE_ID,
        fetch_scope: "body+turn_log",
        required: true,
        purpose: "primary",
      },
      {
        object_kind: "code_tree",
        object_id: "feat/abc",
        fetch_scope: "tree",
        required: false,
        purpose: "self-fetch",
      },
    ];
    const resolver = new StaticResolver(
      new Map([
        [key(drafts[0]!), "pin-slice-1"],
        [key(drafts[1]!), "pin-tree-1"],
      ]),
    );
    const clock = new FixedClock(1_700_000_000_000);
    const b = new ManifestBuilder(resolver, clock);
    const m = await b.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    expect(isUlid(m.manifest_id)).toBe(true);
    expect(m.entries.length).toBe(2);
    expect(m.entries[0]?.revision_pin).toBe("pin-slice-1");
    expect(m.entries[1]?.revision_pin).toBe("pin-tree-1");
    expect(m.created_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("preserves draft order in entries", async () => {
    const drafts: ManifestEntryDraft[] = [
      { object_kind: "slice", object_id: SLICE_ID, fetch_scope: "body", required: true, purpose: "p1" },
      { object_kind: "decision", object_id: "01HZD00000000000000000000A", fetch_scope: "body", required: false, purpose: "p2" },
    ];
    const resolver = new StaticResolver(
      new Map([
        [key(drafts[0]!), "a"],
        [key(drafts[1]!), "b"],
      ]),
    );
    const b = new ManifestBuilder(resolver, new FixedClock(0));
    const m = await b.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    expect(m.entries.map((e) => e.object_kind)).toEqual(["slice", "decision"]);
  });
});

describe("ManifestBuilder.recheckPins", () => {
  it("returns the entries whose pin has drifted", async () => {
    const drafts: ManifestEntryDraft[] = [
      { object_kind: "slice", object_id: SLICE_ID, fetch_scope: "body", required: true, purpose: "p" },
      { object_kind: "code_tree", object_id: "feat/abc", fetch_scope: "tree", required: false, purpose: "p" },
    ];
    const resolver = new StaticResolver(
      new Map([
        [key(drafts[0]!), "v1"],
        [key(drafts[1]!), "v1"],
      ]),
    );
    const b = new ManifestBuilder(resolver, new FixedClock(0));
    const m = await b.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    expect((await b.recheckPins(m)).length).toBe(0);

    resolver.set(drafts[1]!, "v2");
    const stale = await b.recheckPins(m);
    expect(stale.length).toBe(1);
    expect(stale[0]?.object_kind).toBe("code_tree");
  });
});
