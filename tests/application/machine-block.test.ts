import { describe, expect, it } from "vitest";
import {
  buildCanonicalString,
  computeNonce,
  MACHINE_BLOCK_SECRET_ENV_DEFAULT,
  parseLastMatch,
  renderBlock,
  requireMachineBlockSecret,
  sanitizeMarkdown,
  verifyNonce,
} from "../../src/application/machine-block.js";

const PR_FIELDS = {
  review_surface_id: "01HZA00000000000000000000A",
  parent_kind: "slice",
  parent_id: "01HZS00000000000000000000A",
  parent_phase: "n/a",
  head_sha: "deadbeef",
  review_round: "0",
  last_verification_result: "pass",
  idempotency_key: "01HZK00000000000000000000A",
} as const;

const REVIEW_FIELDS = {
  review_surface_id: "01HZA00000000000000000000A",
  parent_kind: "milestone",
  parent_id: "01HZM00000000000000000000A",
  parent_phase: "Discovery",
  review_round: "1",
  session_id: "01HZSE0000000000000000000A",
  turn_index: "2",
  agent_profile_id: "atlas",
  idempotency_key: "01HZK00000000000000000000A",
} as const;

const SECRET = "super-secret-test-only";

describe("requireMachineBlockSecret", () => {
  it("throws when env var is unset", () => {
    expect(() =>
      requireMachineBlockSecret(MACHINE_BLOCK_SECRET_ENV_DEFAULT, {}),
    ).toThrow(/refusing to start/);
  });

  it("throws when env var is empty", () => {
    expect(() =>
      requireMachineBlockSecret(MACHINE_BLOCK_SECRET_ENV_DEFAULT, {
        [MACHINE_BLOCK_SECRET_ENV_DEFAULT]: "",
      }),
    ).toThrow();
  });

  it("returns the secret when set", () => {
    expect(
      requireMachineBlockSecret(MACHINE_BLOCK_SECRET_ENV_DEFAULT, {
        [MACHINE_BLOCK_SECRET_ENV_DEFAULT]: "abc",
      }),
    ).toBe("abc");
  });
});

describe("sanitizeMarkdown", () => {
  it("strips agent-authored llm-team blocks", () => {
    const body = "hello\n<!-- llm-team:pr-machine\nidempotency_key: spoof\n-->\nworld";
    expect(sanitizeMarkdown(body)).toBe("hello\n\nworld");
  });

  it("leaves non-llm-team html comments untouched", () => {
    const body = "x <!-- regular comment --> y";
    expect(sanitizeMarkdown(body)).toBe(body);
  });

  it("strips multiple blocks", () => {
    const body = "a<!-- llm-team:review-machine\nx: 1\n-->b<!-- llm-team:pr-machine\ny:2\n-->c";
    expect(sanitizeMarkdown(body)).toBe("abc");
  });
});

describe("buildCanonicalString / computeNonce / verifyNonce", () => {
  it("HMAC-SHA256 hex prefix 16 is deterministic", () => {
    const a = computeNonce(SECRET, "pr", PR_FIELDS);
    const b = computeNonce(SECRET, "pr", PR_FIELDS);
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("verifyNonce passes when fields & secret match", () => {
    const nonce = computeNonce(SECRET, "pr", PR_FIELDS);
    expect(verifyNonce(SECRET, "pr", PR_FIELDS, nonce)).toBe(true);
  });

  it("verifyNonce fails when ANY single field is altered", () => {
    const nonce = computeNonce(SECRET, "pr", PR_FIELDS);
    for (const k of Object.keys(PR_FIELDS) as (keyof typeof PR_FIELDS)[]) {
      const tampered = { ...PR_FIELDS, [k]: PR_FIELDS[k] + "x" };
      expect(verifyNonce(SECRET, "pr", tampered, nonce)).toBe(false);
    }
  });

  it("verifyNonce fails when secret is wrong", () => {
    const nonce = computeNonce(SECRET, "pr", PR_FIELDS);
    expect(verifyNonce("other-secret", "pr", PR_FIELDS, nonce)).toBe(false);
  });

  it("review-machine block omits PR-only fields and vice versa", () => {
    // canonical string for pr should NOT contain session_id/turn_index/agent_profile_id
    const prCanon = buildCanonicalString("pr", PR_FIELDS);
    expect(prCanon).not.toContain("session_id");
    expect(prCanon).not.toContain("turn_index");
    expect(prCanon).not.toContain("agent_profile_id");
    // canonical string for review should NOT contain head_sha / last_verification_result
    const revCanon = buildCanonicalString("review", REVIEW_FIELDS);
    expect(revCanon).not.toContain("head_sha");
    expect(revCanon).not.toContain("last_verification_result");
    expect(revCanon).toContain("session_id=");
    expect(revCanon).toContain("agent_profile_id=");
  });

  it("PR-machine block includes parent_phase explicitly", () => {
    const canon = buildCanonicalString("pr", PR_FIELDS);
    expect(canon).toContain("|parent_phase=n/a|");
  });
});

describe("renderBlock + parseLastMatch round-trip", () => {
  it("PR block round-trips through render → parse", () => {
    const nonce = computeNonce(SECRET, "pr", PR_FIELDS);
    const block = renderBlock("pr", PR_FIELDS, nonce);
    const parsed = parseLastMatch(block, "pr");
    expect(parsed).not.toBeNull();
    expect(parsed!.fields).toEqual(PR_FIELDS);
    expect(parsed!.nonce).toEqual(nonce);
    expect(verifyNonce(SECRET, "pr", parsed!.fields, parsed!.nonce)).toBe(true);
  });

  it("review block round-trips through render → parse", () => {
    const nonce = computeNonce(SECRET, "review", REVIEW_FIELDS);
    const block = renderBlock("review", REVIEW_FIELDS, nonce);
    const parsed = parseLastMatch(block, "review");
    expect(parsed).not.toBeNull();
    expect(parsed!.fields).toEqual(REVIEW_FIELDS);
    expect(verifyNonce(SECRET, "review", parsed!.fields, parsed!.nonce)).toBe(true);
  });

  it("last-match policy: a Caller-appended block overrides an earlier injected one", () => {
    const callerNonce = computeNonce(SECRET, "review", REVIEW_FIELDS);
    const callerBlock = renderBlock("review", REVIEW_FIELDS, callerNonce);
    // attacker injected a fake block earlier in the body
    const fake = renderBlock(
      "review",
      { ...REVIEW_FIELDS, idempotency_key: "FAKE" },
      "0123456789abcdef",
    );
    const body = `Some review body…\n${fake}\nmore prose\n${callerBlock}`;
    const parsed = parseLastMatch(body, "review");
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.idempotency_key).toBe(REVIEW_FIELDS.idempotency_key);
    expect(verifyNonce(SECRET, "review", parsed!.fields, parsed!.nonce)).toBe(true);
  });

  it("returns null when block is missing", () => {
    expect(parseLastMatch("plain text", "pr")).toBeNull();
  });

  it("returns null when an unknown field is present (forward-compat-strict)", () => {
    const nonce = computeNonce(SECRET, "pr", PR_FIELDS);
    const block = renderBlock("pr", PR_FIELDS, nonce);
    const tampered = block.replace(
      "-->",
      "extra_field: xxx\n-->",
    );
    expect(parseLastMatch(tampered, "pr")).toBeNull();
  });
});
