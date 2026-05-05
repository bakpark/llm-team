import { spawn } from "node:child_process";

export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin: string;
  timeoutSec: number;
  killGraceMs?: number;
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
      proc = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
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
