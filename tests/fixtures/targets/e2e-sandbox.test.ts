import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateOrThrow } from "../../../src/application/config-validator.js";

const FIXTURE_PATH = resolve(__dirname, "e2e-sandbox.json");

describe("e2e-sandbox target fixture", () => {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  it("parses with validateOrThrow (production validator)", () => {
    const cfg = validateOrThrow(raw);
    expect(cfg.identity.target_id).toBe("e2e-sandbox");
  });

  it("declares all four agent profiles", () => {
    const cfg = validateOrThrow(raw);
    expect(cfg.agent_profiles.atlas.runner).toBeDefined();
    expect(cfg.agent_profiles.forge.runner).toBeDefined();
    expect(cfg.agent_profiles.sentinel.runner).toBeDefined();
    expect(cfg.agent_profiles.scout.runner).toBeDefined();
  });

  it("does not use the test-only `fake` runner on any profile", () => {
    const cfg = validateOrThrow(raw);
    for (const profile of [
      cfg.agent_profiles.atlas,
      cfg.agent_profiles.forge,
      cfg.agent_profiles.sentinel,
      cfg.agent_profiles.scout,
    ]) {
      expect(profile.runner).not.toBe("fake");
    }
  });

  it("declares production fields required by §G of pre-e2e-checklist", () => {
    const cfg = validateOrThrow(raw);
    expect(cfg.identity.workdir_path).toBeTruthy();
    expect(cfg.identity.audit_hash_seed).toBeTruthy();
    expect(cfg.governance?.human_team).toBeTruthy();
    expect(cfg.lease?.ttl_default_ms).toBeGreaterThan(0);
    expect(Object.keys(cfg.context_budget ?? {}).length).toBeGreaterThan(0);
  });

  it("isolates GitHub side effects via fs-mirror provider", () => {
    const cfg = validateOrThrow(raw);
    expect(cfg.governance?.human_team_provider).toBe("fs-mirror");
  });
});
