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

  it("does not mask benign env values like HOME/PATH/TMPDIR", () => {
    const env = {
      HOME: "/Users/alice/with-a-long-path",
      PATH: "/usr/local/bin:/usr/bin:/bin:/sbin",
      TMPDIR: "/var/folders/xx/some-temp-dir-1234",
      PWD: "/Users/alice/dev/project-foo",
    };
    const line = `running in ${env.HOME} via ${env.PATH} (tmp=${env.TMPDIR}, cwd=${env.PWD})`;
    expect(redactSecrets(line, env)).toBe(line);
  });

  it("masks values for explicit secret keys (GH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY)", () => {
    const env = {
      GH_TOKEN: "ghs_thisisafaketokenvalue1234",
      ANTHROPIC_API_KEY: "sk-ant-fakekeyvaluehere987654",
      OPENAI_API_KEY: "sk-fakekeyvaluehere1234567",
    };
    const line = `gh=${env.GH_TOKEN} anth=${env.ANTHROPIC_API_KEY} oa=${env.OPENAI_API_KEY}`;
    expect(redactSecrets(line, env)).toBe(
      `gh=${MASK} anth=${MASK} oa=${MASK}`,
    );
  });

  it("masks suffix-matched secret keys case-insensitively", () => {
    const env = {
      MY_SERVICE_SECRET: "topsecretvalue123",
      db_password: "p@ssw0rd-very-long",
      OAUTH_CREDENTIAL: "credential-blob-1234",
      SOME_AUTH: "auth-bearer-blob-1234",
    };
    const line = `s=${env.MY_SERVICE_SECRET} p=${env.db_password} c=${env.OAUTH_CREDENTIAL} a=${env.SOME_AUTH}`;
    expect(redactSecrets(line, env)).toBe(
      `s=${MASK} p=${MASK} c=${MASK} a=${MASK}`,
    );
  });

  it("masks envOverride-injected secrets when passed as additional source", () => {
    const baseEnv = { HOME: "/Users/alice/dev" };
    const overrideEnv = { CUSTOM_API_TOKEN: "overridden-secret-9876" };
    const line = `home=${baseEnv.HOME} tok=${overrideEnv.CUSTOM_API_TOKEN}`;
    expect(redactSecrets(line, baseEnv, overrideEnv)).toBe(
      `home=/Users/alice/dev tok=${MASK}`,
    );
  });

  it("ignores non-secret keys even when value is long", () => {
    const env = { CONFIG_FILE_PATH: "/etc/myapp/config.json.long" };
    const line = `loaded ${env.CONFIG_FILE_PATH} ok`;
    expect(redactSecrets(line, env)).toBe(line);
  });
});
