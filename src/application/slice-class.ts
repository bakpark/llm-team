/**
 * SOC-SLICE-CLASS / TCC-SLICE-CLASS-RULES — internal → feature escalation.
 *
 * Caller 가 internal slice 를 SLICE_BUILDING 으로 전이하기 직전 (Planning 의
 * plan_accept 직후) 호출한다. 6 rule 중 하나라도 hit 하면 effective_kind 가
 * `feature` 로 승격되며, 이는 invariant #5 (사람 게이트 강제) 를 보장한다.
 *
 * 본 모듈은 순수 함수 — 외부 verification runner / metric runner availability
 * 신호는 input 에 명시 전달된다.
 */
import type { Slice } from "../domain/schema/slice.js";
import {
  InternalEscalationRules as InternalEscalationRulesSchema,
  type InternalEscalationRules,
} from "../config/target-schema.js";

export type EscalationRuleId =
  | "interface_break"
  | "schema_or_migration_change"
  | "security_sensitive_path"
  | "perf_critical_path"
  | "existing_test_coverage_below_threshold"
  | "metric_runner_unavailable";

export interface EscalationHit {
  rule: EscalationRuleId;
  reason: string;
}

export interface SliceClassResult {
  declared_kind: "feature" | "internal";
  effective_kind: "feature" | "internal";
  escalation_hits: EscalationHit[];
}

export interface ClassifySliceInput {
  slice: Pick<
    Slice,
    "slice_kind" | "declared_scope" | "interface_break" | "declared_metric_threshold"
  >;
  rules: InternalEscalationRules | undefined;
  /** Caller-provided runtime signals. */
  context: {
    /** Existing test coverage of declared_scope (0.0–1.0). null = unknown. */
    existing_test_coverage: number | null;
    /** Whether the metric runner is currently available. */
    metric_runner_available: boolean;
  };
}

/**
 * Glob match: very small subset — `*` (any chars within a segment) and `**`
 * (any path including `/`). Targets are POSIX-like paths. We anchor on the
 * full string and convert each glob to a regex.
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c!)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function anyMatch(scope: readonly string[], patterns: readonly string[]): string | null {
  for (const p of patterns) {
    const re = globToRegex(p);
    for (const s of scope) {
      if (re.test(s)) return `${s} matches ${p}`;
    }
  }
  return null;
}

export function classifySlice(input: ClassifySliceInput): SliceClassResult {
  const declared = input.slice.slice_kind;
  if (declared === "feature") {
    return {
      declared_kind: "feature",
      effective_kind: "feature",
      escalation_hits: [],
    };
  }

  const hits: EscalationHit[] = [];
  const rules = input.rules;
  if (rules == null) {
    // No rules block — invariant: default-on 6 rules. Re-resolve via parse.
    return classifySlice({
      ...input,
      rules: defaultEscalationRules(),
    });
  }

  if (rules.interface_break.enabled && input.slice.interface_break) {
    hits.push({
      rule: "interface_break",
      reason: "slice.interface_break = true",
    });
  } else if (
    rules.interface_break.enabled &&
    rules.interface_break.protected_apis.length > 0
  ) {
    const m = anyMatch(
      input.slice.declared_scope,
      rules.interface_break.protected_apis,
    );
    if (m != null) hits.push({ rule: "interface_break", reason: m });
  }

  if (
    rules.schema_or_migration_change.enabled &&
    rules.schema_or_migration_change.paths.length > 0
  ) {
    const m = anyMatch(
      input.slice.declared_scope,
      rules.schema_or_migration_change.paths,
    );
    if (m != null) hits.push({ rule: "schema_or_migration_change", reason: m });
  }

  if (
    rules.security_sensitive_path.enabled &&
    rules.security_sensitive_path.paths.length > 0
  ) {
    const m = anyMatch(
      input.slice.declared_scope,
      rules.security_sensitive_path.paths,
    );
    if (m != null) hits.push({ rule: "security_sensitive_path", reason: m });
  }

  if (
    rules.perf_critical_path.enabled &&
    rules.perf_critical_path.paths.length > 0
  ) {
    const m = anyMatch(
      input.slice.declared_scope,
      rules.perf_critical_path.paths,
    );
    if (m != null) hits.push({ rule: "perf_critical_path", reason: m });
  }

  if (rules.existing_test_coverage_below_threshold.enabled) {
    const cov = input.context.existing_test_coverage;
    if (cov != null && cov < rules.existing_test_coverage_below_threshold.threshold) {
      hits.push({
        rule: "existing_test_coverage_below_threshold",
        reason: `coverage ${cov.toFixed(3)} < threshold ${rules.existing_test_coverage_below_threshold.threshold}`,
      });
    }
  }

  if (
    rules.metric_runner_unavailable.enabled &&
    input.slice.declared_metric_threshold != null &&
    !input.context.metric_runner_available
  ) {
    hits.push({
      rule: "metric_runner_unavailable",
      reason: "declared_metric_threshold present but metric runner unavailable",
    });
  }

  return {
    declared_kind: "internal",
    effective_kind: hits.length > 0 ? "feature" : "internal",
    escalation_hits: hits,
  };
}

function defaultEscalationRules(): InternalEscalationRules {
  return InternalEscalationRulesSchema.parse({});
}
