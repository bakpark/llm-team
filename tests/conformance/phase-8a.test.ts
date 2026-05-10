/**
 * Phase 8a contract conformance — TCC-CONTEXT-BUDGET + AGC-CONTEXT-BUDGET
 * surfaces.
 *
 * Anchors:
 *   - TCC-CONTEXT-BUDGET (new row in contracts/README matrix; schema +
 *     resolver in src/config/target-schema.ts)
 *   - AGC-CONTEXT-BUDGET (now `partial` — caller cap enforcement lives in
 *     src/application/prompt-compose.ts)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_BUDGET_DEFAULTS,
  ContextBudget,
  ContextBudgetEntry,
  LoopStep,
  resolveContextBudget,
  TargetConfig,
} from "../../src/config/target-schema.js";
import { ManifestBuilder } from "../../src/application/manifest-builder.js";
import {
  composePromptWithBudget,
  type ComposePromptWithBudgetInput,
} from "../../src/application/prompt-compose.js";
import { FixedClock } from "../../src/ports/clock.js";
import type {
  ManifestEntryDraft,
  RevisionPinResolver,
} from "../../src/application/manifest-builder.js";

const REPO_ROOT = resolve(__dirname, "../..");
const README = resolve(REPO_ROOT, "docs/contracts/README.md");

const PHASE_8A_ANCHORS = ["TCC-CONTEXT-BUDGET", "AGC-CONTEXT-BUDGET"];

function findRowForAnchor(readme: string, anchor: string): string {
  const re = new RegExp(`^\\|\\s*\`${anchor}\`[^\\n]*\\|`, "m");
  const m = readme.match(re);
  if (!m) throw new Error(`anchor ${anchor} not found in README matrix`);
  return m[0];
}

function extractTsPaths(matrixRow: string): string[] {
  const paths = new Set<string>();
  const re = /`(src\/[^`\s]+\.ts)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(matrixRow)) != null) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

describe("Phase 8a — contract conformance matrix", () => {
  const readme = readFileSync(README, "utf8");

  for (const anchor of PHASE_8A_ANCHORS) {
    it(`${anchor} row references at least one src/**/*.ts surface that exists`, () => {
      const row = findRowForAnchor(readme, anchor);
      const paths = extractTsPaths(row);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(resolve(REPO_ROOT, p)), `missing file: ${p}`).toBe(
          true,
        );
      }
    });
  }

  it("TCC-CONTEXT-BUDGET row cites schema + prompt-compose surfaces", () => {
    const row = findRowForAnchor(readme, "TCC-CONTEXT-BUDGET");
    expect(row).toContain("src/config/target-schema.ts");
    expect(row).toContain("src/application/prompt-compose.ts");
    expect(row).toContain("ContextBudget");
    expect(row).toContain("LoopStep");
  });

  it("AGC-CONTEXT-BUDGET row is no longer spec-only", () => {
    const row = findRowForAnchor(readme, "AGC-CONTEXT-BUDGET");
    expect(row).toContain("partial");
    expect(row).toContain("src/application/prompt-compose.ts");
    expect(row).toContain("composePromptWithBudget");
    expect(row).toContain("context_budget_truncation");
  });
});

describe("Phase 8a — TCC-CONTEXT-BUDGET schema", () => {
  it("LoopStep enum covers every (parent_loop, phase_or_purpose) pair the architecture defaults specify", () => {
    expect(LoopStep.options.sort()).toEqual(
      [
        "outer.Discovery",
        "outer.Specification",
        "outer.Planning",
        "outer.Validation",
        "middle.review",
        "middle.merge",
        "inner.tdd_build",
      ].sort(),
    );
  });

  it("CONTEXT_BUDGET_DEFAULTS reproduces the architecture defaults verbatim", () => {
    expect(CONTEXT_BUDGET_DEFAULTS["outer.Discovery"].token_hard_cap).toBe(
      256_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["outer.Specification"].token_hard_cap).toBe(
      256_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["outer.Planning"].token_hard_cap).toBe(
      256_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["outer.Validation"].token_hard_cap).toBe(
      256_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["middle.review"].token_hard_cap).toBe(
      192_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["middle.merge"].token_hard_cap).toBe(
      128_000,
    );
    expect(CONTEXT_BUDGET_DEFAULTS["inner.tdd_build"].token_hard_cap).toBe(
      128_000,
    );
  });

  it("ContextBudgetEntry rejects non-positive token_hard_cap", () => {
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: 0 }),
    ).toThrow();
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: -1 }),
    ).toThrow();
    expect(
      ContextBudgetEntry.parse({ token_hard_cap: 100, soft_warn_pct: 0.8 })
        .soft_warn_pct,
    ).toBe(0.8);
    expect(() =>
      ContextBudgetEntry.parse({ token_hard_cap: 100, soft_warn_pct: 1.1 }),
    ).toThrow();
  });

  it("ContextBudget rejects unknown LoopStep keys", () => {
    expect(() =>
      ContextBudget.parse({
        "outer.Discovery": { token_hard_cap: 1 },
        "outer.Frobnication": { token_hard_cap: 1 },
      }),
    ).toThrow();
  });

  it("TargetConfig accepts an optional context_budget block", () => {
    const cfg = TargetConfig.parse({
      identity: { target_id: "t1" },
      agent_profiles: {
        atlas: { runner: "fake" },
        forge: { runner: "fake" },
        sentinel: { runner: "fake" },
        scout: { runner: "fake" },
      },
      context_budget: {
        "inner.tdd_build": { token_hard_cap: 32_000 },
      },
    });
    expect(cfg.context_budget?.["inner.tdd_build"]?.token_hard_cap).toBe(
      32_000,
    );
  });

  it("resolveContextBudget falls back to architecture defaults when no override is given", () => {
    expect(
      resolveContextBudget(undefined, "inner", "tdd_build")?.token_hard_cap,
    ).toBe(128_000);
    expect(
      resolveContextBudget({}, "outer", "Discovery")?.token_hard_cap,
    ).toBe(256_000);
  });

  it("resolveContextBudget respects target operator overrides", () => {
    const cfg = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 1_000 },
    });
    expect(
      resolveContextBudget(cfg, "inner", "tdd_build")?.token_hard_cap,
    ).toBe(1_000);
  });

  it("resolveContextBudget returns null for unknown (loop, step) pairs", () => {
    expect(resolveContextBudget({}, "outer", "Frobnication")).toBeNull();
    expect(resolveContextBudget({}, "rogue", "tdd_build")).toBeNull();
  });
});

describe("Phase 8a — manifest-builder token_estimate", () => {
  const SESSION_ID = "01HZSE0000000000000000000A";
  const SLICE_ID = "01HZS00000000000000000000A";

  class StaticResolver implements RevisionPinResolver {
    constructor(private readonly pin: string) {}
    async resolve(_d: ManifestEntryDraft): Promise<string> {
      return this.pin;
    }
  }

  it("attaches a positive integer token_estimate per entry", async () => {
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
    const b = new ManifestBuilder(
      new StaticResolver("pin-1"),
      new FixedClock(0),
    );
    const m = await b.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    for (const e of m.entries) {
      expect(e.token_estimate).toBeDefined();
      expect(Number.isInteger(e.token_estimate!)).toBe(true);
      expect(e.token_estimate!).toBeGreaterThan(0);
    }
  });

  it("token_estimate is deterministic for identical inputs", async () => {
    const drafts: ManifestEntryDraft[] = [
      {
        object_kind: "slice",
        object_id: SLICE_ID,
        fetch_scope: "body",
        required: true,
        purpose: "primary",
      },
    ];
    const b1 = new ManifestBuilder(
      new StaticResolver("pin-x"),
      new FixedClock(0),
    );
    const b2 = new ManifestBuilder(
      new StaticResolver("pin-x"),
      new FixedClock(0),
    );
    const m1 = await b1.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    const m2 = await b2.build({
      session_id: SESSION_ID,
      turn_index: 0,
      purpose: "tdd_build",
      target: { object_kind: "slice", object_id: SLICE_ID },
      drafts,
    });
    expect(m1.entries[0]?.token_estimate).toBe(m2.entries[0]?.token_estimate);
  });
});

describe("Phase 8a — composePromptWithBudget enforcement", () => {
  const SESSION_ID = "01HZSE0000000000000000000A";
  const SLICE_ID = "01HZS00000000000000000000A";

  function baseInput(
    extras: Partial<ComposePromptWithBudgetInput> = {},
  ): ComposePromptWithBudgetInput {
    return {
      agentProfileId: "forge",
      agentRoleInSession: "lead",
      parentLoop: "inner",
      phaseOrPurpose: "tdd_build",
      sessionId: SESSION_ID,
      turnIndex: 0,
      manifest: {
        manifest_id: "01HZM00000000000000000000A",
        session_id: SESSION_ID,
        turn_index: 0,
        purpose: "tdd_build",
        target: { object_kind: "slice", object_id: SLICE_ID },
        entries: [],
        created_at: new Date(0).toISOString(),
      },
      workspaceRevisionPin: "deadbeef",
      ...extras,
    };
  }

  it("returns ok with no truncation when total fits the cap", () => {
    const input = baseInput({
      manifest: {
        ...baseInput().manifest,
        entries: [
          {
            object_kind: "slice",
            object_id: SLICE_ID,
            fetch_scope: "body+turn_log",
            revision_pin: "p1",
            required: true,
            purpose: "primary",
            token_estimate: 100,
          },
        ],
      },
    });
    const r = composePromptWithBudget(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.droppedEntries.length).toBe(0);
      expect(r.cap).toBe(128_000);
      expect(r.tokenEstimate).toBeGreaterThan(0);
      expect(r.body).toContain("# Context");
    }
  });

  it("drops low-priority (tree → body+turn_log → body+comments → body) entries first when over cap", () => {
    // Cap must clear PROMPT_SCAFFOLD_TOKENS (1200) + required body entry +
    // framing so the post-drop state actually fits — the assertion under
    // test is the drop ORDERING, not the absolute headroom.
    const tinyCap: ContextBudget = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 1_500 },
    });
    const input = baseInput({
      contextBudget: tinyCap,
      manifest: {
        ...baseInput().manifest,
        entries: [
          {
            object_kind: "slice",
            object_id: SLICE_ID,
            fetch_scope: "body",
            revision_pin: "p1",
            required: true,
            purpose: "primary",
            token_estimate: 100,
          },
          {
            object_kind: "code_tree",
            object_id: "feat/abc",
            fetch_scope: "tree",
            revision_pin: "p2",
            required: false,
            purpose: "self-fetch",
            token_estimate: 5_000,
          },
          {
            object_kind: "session_turn",
            object_id: "01HZT00000000000000000000A",
            fetch_scope: "body+turn_log",
            revision_pin: "p3",
            required: false,
            purpose: "history",
            token_estimate: 100,
          },
        ],
      },
    });
    const r = composePromptWithBudget(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // tree (lowest priority) MUST be dropped first.
      const droppedScopes = r.droppedEntries.map((e) => e.fetch_scope);
      expect(droppedScopes[0]).toBe("tree");
      // The required body entry MUST NOT be dropped.
      expect(r.droppedEntries.find((e) => e.required)).toBeUndefined();
      expect(r.tokenEstimate).toBeLessThanOrEqual(1_500);
    }
  });

  it("emits context_budget_truncation invalid when only required entries remain and still overflow", () => {
    const tinyCap: ContextBudget = ContextBudget.parse({
      "inner.tdd_build": { token_hard_cap: 200 },
    });
    const input = baseInput({
      contextBudget: tinyCap,
      manifest: {
        ...baseInput().manifest,
        entries: [
          {
            object_kind: "slice",
            object_id: SLICE_ID,
            fetch_scope: "body",
            revision_pin: "p1",
            required: true,
            purpose: "primary",
            token_estimate: 10_000,
          },
        ],
      },
    });
    const r = composePromptWithBudget(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("context_budget_truncation");
      expect(r.cap).toBe(200);
      expect(r.detail).toMatch(/overflow/);
    }
  });

  it("emits context_budget_truncation when (parent_loop, phase_or_purpose) is unknown", () => {
    const input = baseInput({
      parentLoop: "outer" as const,
      phaseOrPurpose: "Frobnication",
    });
    const r = composePromptWithBudget(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("context_budget_truncation");
      expect(r.cap).toBeNull();
    }
  });

  it("falls back to architecture default cap when contextBudget is omitted", () => {
    const r = composePromptWithBudget(baseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cap).toBe(128_000);
  });

  // PR #93 P1-B: dedicated coverage for `checkResolvedBodyBudget` 2x safety
  // margin. Three cases: (a) under margin → ok, (b) exactly at margin → ok,
  // (c) clearly over margin → context_budget_truncation.
  describe("resolved-body 2x safety margin (PR #93 P1-B)", () => {
    function inputWithResolved(tokenEstimate: number, bodyChars: number) {
      return baseInput({
        manifest: {
          ...baseInput().manifest,
          entries: [
            {
              object_kind: "milestone",
              object_id: "01HZMS0000000000000000000A",
              fetch_scope: "body",
              revision_pin: "p1",
              required: true,
              purpose: "primary",
              token_estimate: tokenEstimate,
            },
          ],
        },
        resolvedEntries: [
          { manifest_entry_index: 0, body: "x".repeat(bodyChars) },
        ],
      });
    }

    it("accepts a resolved body well under token_estimate × 2", () => {
      // token_estimate=100 → cap=200 tokens (~800 chars). Use 400 chars (~100 tokens).
      const r = composePromptWithBudget(inputWithResolved(100, 400));
      expect(r.ok).toBe(true);
    });

    it("accepts a resolved body exactly at token_estimate × 2", () => {
      // token_estimate=100, cap=200 tokens. ceil(800/4)=200 exactly.
      const r = composePromptWithBudget(inputWithResolved(100, 800));
      expect(r.ok).toBe(true);
    });

    it("emits context_budget_truncation when resolved body clearly exceeds token_estimate × 2", () => {
      // token_estimate=100, cap=200 tokens. ceil(2000/4)=500 → over.
      const r = composePromptWithBudget(inputWithResolved(100, 2000));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("context_budget_truncation");
        expect(r.detail).toMatch(/exceeds token_estimate × 2/);
      }
    });
  });
});
