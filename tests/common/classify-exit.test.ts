import { describe, expect, it } from "vitest";
import { classifyExit } from "../../src/ports/llm-runner.js";

describe("classifyExit", () => {
  it("returns ok for rawCode 0", () => {
    expect(classifyExit({ rawCode: 0, signal: null, timedOut: false })).toBe("ok");
  });

  it("returns timeout when timedOut flag is true regardless of code/signal", () => {
    expect(classifyExit({ rawCode: null, signal: "SIGTERM", timedOut: true })).toBe("timeout");
    expect(classifyExit({ rawCode: 0, signal: null, timedOut: true })).toBe("timeout");
  });

  it("maps known raw codes", () => {
    expect(classifyExit({ rawCode: 64, signal: null, timedOut: false })).toBe("transport_error");
    expect(classifyExit({ rawCode: 65, signal: null, timedOut: false })).toBe("malformed_output");
    expect(classifyExit({ rawCode: 66, signal: null, timedOut: false })).toBe("adapter_unavailable");
    expect(classifyExit({ rawCode: 67, signal: null, timedOut: false })).toBe("malformed_output");
    expect(classifyExit({ rawCode: 124, signal: null, timedOut: false })).toBe("timeout");
    expect(classifyExit({ rawCode: 127, signal: null, timedOut: false })).toBe("adapter_unavailable");
  });

  it("falls back to transport_error for unknown rawCode", () => {
    expect(classifyExit({ rawCode: 42, signal: null, timedOut: false })).toBe("transport_error");
  });

  it("classifies external SIGTERM as transport_error", () => {
    expect(classifyExit({ rawCode: null, signal: "SIGTERM", timedOut: false })).toBe("transport_error");
  });
});
