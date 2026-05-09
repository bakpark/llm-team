import { spawn } from "node:child_process";

export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  /**
   * Explicit env to pass to the child. When omitted, `process.env` is used.
   * Adapters that want allowlist/override semantics should compose envOverride
   * via {@link resolveSpawnEnv} before calling.
   */
  env?: NodeJS.ProcessEnv;
  stdin: string;
  timeoutSec: number;
  killGraceMs?: number;
}

export interface ResolveSpawnEnvOpts {
  /** Source env. Defaults to `process.env`. */
  base?: NodeJS.ProcessEnv;
  /**
   * Optional allowlist. When provided, only these keys are kept from `base`.
   * `override` keys are still added afterwards.
   */
  allowlist?: readonly string[];
  /** Keys to add or replace on top of the (possibly filtered) base. */
  override?: NodeJS.ProcessEnv;
}

/**
 * Compose an env for spawnWithTimeout. Default behavior returns
 * `process.env` unchanged so adapters do not silently drop PATH or other
 * runtime variables. Use `allowlist` for opt-in tightening and `override`
 * for additive secrets/config.
 */
export function resolveSpawnEnv(
  opts: ResolveSpawnEnvOpts = {},
): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  let result: NodeJS.ProcessEnv;
  if (opts.allowlist) {
    result = {};
    for (const key of opts.allowlist) {
      const v = base[key];
      if (v !== undefined) result[key] = v;
    }
  } else {
    result = { ...base };
  }
  if (opts.override) {
    for (const [k, v] of Object.entries(opts.override)) {
      if (v === undefined) continue;
      result[k] = v;
    }
  }
  return result;
}

export interface SpawnResult {
  rawCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export async function spawnWithTimeout(opts: SpawnOpts): Promise<SpawnResult> {
  const killGraceMs = opts.killGraceMs ?? 2000;
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    let proc: ReturnType<typeof spawn>;
    try {
      // Default to inheriting process.env so adapters never silently drop
      // PATH/HOME and similar runtime variables. Callers wanting allowlist
      // semantics build env via resolveSpawnEnv() and pass it explicitly.
      const env = opts.env ?? process.env;
      proc = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const isENoEnt = err.code === "ENOENT";
      resolve({
        rawCode: isENoEnt ? 127 : null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: `spawn failed: ${err.message}`,
      });
      return;
    }

    proc.on("error", (err: NodeJS.ErrnoException) => {
      const isENoEnt = err.code === "ENOENT";
      cleanup();
      resolve({
        rawCode: isENoEnt ? 127 : null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr + `spawn error: ${err.message}`,
      });
    });

    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    proc.stdin!.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE means the child closed stdin before we finished writing —
      // common for fast-failing CLIs. Swallow and let exit handler classify.
      if (err.code !== "EPIPE") {
        stderr += `stdin error: ${err.message}\n`;
      }
    });

    proc.stdin!.end(opts.stdin);

    if (opts.timeoutSec > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        graceTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already exited */
          }
        }, killGraceMs);
      }, opts.timeoutSec * 1000);
    }

    function cleanup() {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
    }

    proc.on("close", (code, signal) => {
      cleanup();
      resolve({
        rawCode: code,
        signal: signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}
