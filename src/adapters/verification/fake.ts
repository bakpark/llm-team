import type { FailedTest } from "../../domain/schema/verification.js";
import type {
  CommandSpec,
  MetricOutcome,
  VerificationOutcome,
  VerificationPort,
} from "../../ports/verification.js";
import type { ClockPort } from "../../ports/clock.js";

/**
 * Fake verification adapter — returns scripted outcomes based on the first
 * argv token. Used by integration tests so an inner cycle can exercise the
 * full pass/fail branches without forking real binaries.
 */
export interface FakeOutcomeMap {
  build?: VerificationOutcomeOverride;
  test?: VerificationOutcomeOverride;
  lint?: VerificationOutcomeOverride;
  metric?: { result: "met" | "unmet"; value: number };
}

export type VerificationOutcomeOverride = {
  result: "pass" | "fail" | "error";
  failed_tests?: FailedTest[];
};

export class FakeVerification implements VerificationPort {
  constructor(
    private readonly clock: ClockPort,
    private readonly outcomes: FakeOutcomeMap = {},
  ) {}

  async runBuild(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.outcome(commands, this.outcomes.build ?? { result: "pass" });
  }

  async runTest(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.outcome(commands, this.outcomes.test ?? { result: "pass" });
  }

  async runLint(commands: CommandSpec[]): Promise<VerificationOutcome> {
    return this.outcome(commands, this.outcomes.lint ?? { result: "pass" });
  }

  async runMetric(input: {
    command: CommandSpec;
    compare: (value: number) => "met" | "unmet";
  }): Promise<MetricOutcome> {
    const o = this.outcomes.metric ?? { result: "met", value: 0 };
    const startedAt = this.clock.isoNow();
    const finishedAt = this.clock.isoNow();
    return {
      result: o.result,
      value: o.value,
      log: `[fake metric: ${o.value}]`,
      startedAt,
      finishedAt,
    };
  }

  private outcome(
    commands: CommandSpec[],
    o: VerificationOutcomeOverride,
  ): VerificationOutcome {
    const startedAt = this.clock.isoNow();
    const finishedAt = this.clock.isoNow();
    return {
      result: o.result,
      log: commands.map((c) => `$ ${c.argv.join(" ")}`).join("\n"),
      failed_tests: o.failed_tests ?? [],
      startedAt,
      finishedAt,
      exitCodes: commands.map(() => (o.result === "pass" ? 0 : 1)),
    };
  }
}
