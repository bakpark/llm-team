import { describe, expect, it } from "vitest";
import {
  classifyExit,
  classifyTransportReason,
} from "../../src/ports/llm-runner.js";

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

describe("classifyTransportReason", () => {
  it("returns 'other' for empty stderr", () => {
    expect(classifyTransportReason({ stderr: "" })).toBe("other");
  });

  it("detects rate_limit (429 or 'rate limit')", () => {
    expect(classifyTransportReason({ stderr: "HTTP 429 Too Many Requests" })).toBe("rate_limit");
    expect(classifyTransportReason({ stderr: "anthropic: rate limit exceeded" })).toBe("rate_limit");
    expect(classifyTransportReason({ stderr: "error: rate_limit_error" })).toBe("rate_limit");
  });

  it("detects quota over rate-limit when both could match", () => {
    expect(classifyTransportReason({ stderr: "insufficient_quota: please add billing" })).toBe("quota");
    expect(classifyTransportReason({ stderr: "monthly usage limit reached" })).toBe("quota");
  });

  it("detects auth_fail with priority over rate-limit", () => {
    expect(classifyTransportReason({ stderr: "401 Unauthorized" })).toBe("auth_fail");
    expect(classifyTransportReason({ stderr: "Error: Invalid API key provided" })).toBe("auth_fail");
    expect(classifyTransportReason({ stderr: "authentication failed (rate limit may also apply)" })).toBe("auth_fail");
  });

  it("detects network errors", () => {
    expect(classifyTransportReason({ stderr: "fetch failed: ECONNRESET" })).toBe("network");
    expect(classifyTransportReason({ stderr: "getaddrinfo ENOTFOUND api.openai.com" })).toBe("network");
    expect(classifyTransportReason({ stderr: "connection refused" })).toBe("network");
  });

  it("falls back to 'other' for unrecognized stderr", () => {
    expect(classifyTransportReason({ stderr: "unexpected internal error" })).toBe("other");
  });

  it("does not partially-match unrelated tokens", () => {
    expect(classifyTransportReason({ stderr: "scarf" })).toBe("other");
    // Word-boundary keeps embedded digits ('4290') from matching '429'.
    expect(classifyTransportReason({ stderr: "code 4290 next" })).toBe("other");
  });
});
