import { describe, expect, it } from "vitest";
import { classifySlice } from "../../src/application/slice-class.js";
import { InternalEscalationRules } from "../../src/config/target-schema.js";

const baseSlice = {
  slice_kind: "internal" as const,
  declared_scope: ["src/foo/bar.ts"] as readonly string[],
  interface_break: false,
  declared_metric_threshold: null as Parameters<
    typeof classifySlice
  >[0]["slice"]["declared_metric_threshold"],
};

const baseContext = {
  existing_test_coverage: 0.9,
  metric_runner_available: true,
};

describe("classifySlice", () => {
  it("feature slice always stays feature", () => {
    const r = classifySlice({
      slice: { ...baseSlice, slice_kind: "feature" },
      rules: undefined,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits).toEqual([]);
  });

  it("internal with no hits stays internal (defaults)", () => {
    const r = classifySlice({
      slice: baseSlice,
      rules: undefined,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("internal");
    expect(r.escalation_hits).toEqual([]);
  });

  it("interface_break = true escalates to feature", () => {
    const r = classifySlice({
      slice: { ...baseSlice, interface_break: true },
      rules: undefined,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("interface_break");
  });

  it("declared_scope matching protected_apis escalates", () => {
    const rules = InternalEscalationRules.parse({
      interface_break: { protected_apis: ["src/api/**"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["src/api/users.ts"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("interface_break");
  });

  it("schema_or_migration_change path match escalates", () => {
    const rules = InternalEscalationRules.parse({
      schema_or_migration_change: { paths: ["migrations/*.sql"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["migrations/0001_init.sql"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("schema_or_migration_change");
  });

  it("security_sensitive_path match escalates", () => {
    const rules = InternalEscalationRules.parse({
      security_sensitive_path: { paths: ["src/auth/**"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["src/auth/login.ts"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("security_sensitive_path");
  });

  it("perf_critical_path match escalates", () => {
    const rules = InternalEscalationRules.parse({
      perf_critical_path: { paths: ["src/hot-path/**"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["src/hot-path/loop.ts"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("perf_critical_path");
  });

  it("coverage below threshold escalates", () => {
    const r = classifySlice({
      slice: baseSlice,
      rules: undefined,
      context: { existing_test_coverage: 0.4, metric_runner_available: true },
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe(
      "existing_test_coverage_below_threshold",
    );
  });

  it("coverage = null does NOT escalate (unknown ≠ below)", () => {
    const r = classifySlice({
      slice: baseSlice,
      rules: undefined,
      context: { existing_test_coverage: null, metric_runner_available: true },
    });
    expect(r.effective_kind).toBe("internal");
  });

  it("declared_metric_threshold + runner unavailable escalates", () => {
    const r = classifySlice({
      slice: {
        ...baseSlice,
        declared_metric_threshold: {
          metric_name: "cycle_complexity",
          comparator: "lte",
          value: 10,
        },
      },
      rules: undefined,
      context: { existing_test_coverage: 0.9, metric_runner_available: false },
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits[0]?.rule).toBe("metric_runner_unavailable");
  });

  it("metric_runner_unavailable does NOT escalate when threshold absent", () => {
    const r = classifySlice({
      slice: baseSlice,
      rules: undefined,
      context: { existing_test_coverage: 0.9, metric_runner_available: false },
    });
    expect(r.effective_kind).toBe("internal");
  });

  it("disabled rule does not fire", () => {
    const rules = InternalEscalationRules.parse({
      interface_break: { enabled: false, protected_apis: ["src/api/**"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["src/api/users.ts"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("internal");
  });

  it("multiple rules can hit at once", () => {
    const rules = InternalEscalationRules.parse({
      interface_break: { protected_apis: ["src/api/**"] },
      security_sensitive_path: { paths: ["src/api/**"] },
    });
    const r = classifySlice({
      slice: { ...baseSlice, declared_scope: ["src/api/auth.ts"] },
      rules,
      context: baseContext,
    });
    expect(r.effective_kind).toBe("feature");
    expect(r.escalation_hits.length).toBe(2);
  });
});
