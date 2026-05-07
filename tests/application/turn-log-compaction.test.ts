import { describe, expect, it } from "vitest";
import { shouldCompactTurnLog } from "../../src/application/turn-log-compaction.js";

describe("shouldCompactTurnLog", () => {
  it("does not fire when policy is disabled (every_n_turns=0)", () => {
    expect(
      shouldCompactTurnLog({ current_turn_index: 100 }, { every_n_turns: 0 }),
    ).toEqual({ fire: false, triggered_at_turn_index: null });
  });

  it("does not fire before the first turn", () => {
    expect(
      shouldCompactTurnLog({ current_turn_index: 0 }, { every_n_turns: 5 }),
    ).toEqual({ fire: false, triggered_at_turn_index: null });
  });

  it("fires every N persisted turns", () => {
    expect(
      shouldCompactTurnLog({ current_turn_index: 5 }, { every_n_turns: 5 }),
    ).toEqual({ fire: true, triggered_at_turn_index: 4 });
    expect(
      shouldCompactTurnLog({ current_turn_index: 10 }, { every_n_turns: 5 }),
    ).toEqual({ fire: true, triggered_at_turn_index: 9 });
  });

  it("does not fire between boundaries", () => {
    expect(
      shouldCompactTurnLog({ current_turn_index: 7 }, { every_n_turns: 5 }),
    ).toEqual({ fire: false, triggered_at_turn_index: null });
  });
});
