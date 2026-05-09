import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/adapters/llm-runner/common/redact.js";

const MASK = "[REDACTED]";

describe("redactSecrets", () => {
  it("returns input unchanged when nothing matches", () => {
    expect(redactSecrets("plain log line", {})).toBe("plain log line");
    expect(redactSecrets("", {})).toBe("");
  });

  it("redacts GitHub classic PAT", () => {
    const s = "auth ghp_abcdefghijklmnopqrstuvwxyz12345 trailing";
    expect(redactSecrets(s, {})).toBe(`auth ${MASK} trailing`);
  });

  it("redacts GitHub fine-grained PAT", () => {
    const s = "token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890abc end";
    expect(redactSecrets(s, {})).toBe(`token=${MASK} end`);
  });

  it("redacts Anthropic key before generic sk-", () => {
    const s = "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ok";
    expect(redactSecrets(s, {})).toBe(`key ${MASK} ok`);
  });

  it("redacts OpenAI sk- key", () => {
    const s = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 done";
    expect(redactSecrets(s, {})).toBe(`OPENAI_API_KEY=${MASK} done`);
  });

  it("redacts Bearer header", () => {
    const s = "Authorization: Bearer abcdefghijklmnopqrstuv";
    expect(redactSecrets(s, {})).toBe(`Authorization: ${MASK}`);
  });

  it("redacts literal env values that appear in the input", () => {
    const env = { GITHUB_TOKEN: "supersecret-12345-token" };
    const s = `Header: ${env.GITHUB_TOKEN} appended`;
    expect(redactSecrets(s, env)).toBe(`Header: ${MASK} appended`);
  });

  it("ignores short env values to avoid scrubbing common settings", () => {
    const env = { NODE_ENV: "test", DEBUG: "1" };
    expect(redactSecrets("running with NODE_ENV=test", env)).toBe(
      "running with NODE_ENV=test",
    );
  });

  it("does not partially-match unrelated words", () => {
    expect(redactSecrets("riskscanner risky scarf", {})).toBe(
      "riskscanner risky scarf",
    );
  });

  it("handles multiple secrets in one input", () => {
    const s =
      "ghp_abcdefghijklmnopqrstuvwxyz12345 then sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(s, {})).toBe(`${MASK} then ${MASK}`);
  });

  it("env value match handles regex-special characters literally", () => {
    const env = { WEIRD_TOKEN: "abc.def+ghi/jkl=12345678" };
    const s = `value=${env.WEIRD_TOKEN} suffix`;
    expect(redactSecrets(s, env)).toBe(`value=${MASK} suffix`);
  });
});
