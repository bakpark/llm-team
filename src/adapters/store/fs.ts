import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { StorePort } from "../../ports/store.js";

export interface FsStoreOptions {
  /** Absolute path to workdir root. All relPaths resolve under this. */
  workdir: string;
  /** Whether to fsync the parent directory after rename. Default true. */
  fsyncDir?: boolean;
  /** Max time to wait for cross-process lock acquisition. Default 30000ms. */
  lockTimeoutMs?: number;
  /** Lockdir age beyond which the lock is treated as stale. Default 60_000ms. */
  staleLockMs?: number;
  /**
   * Lockdir age below which a missing keeper is interpreted as a winner mid-
   * acquisition (mkdir succeeded but writeFile keeper not yet completed).
   * Default 1_000ms. Must be ≪ staleLockMs so abandoned locks are still
   * reclaimed in a timely fashion.
   */
  raceWindowMs?: number;
}

const LOCK_KEEPER = ".holder";

export class FsStore implements StorePort {
  private readonly workdir: string;
  private readonly fsyncDir: boolean;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly raceWindowMs: number;
  /** Per-path in-process serialization for appendLine. */
  private readonly appendChains = new Map<string, Promise<unknown>>();

  constructor(opts: FsStoreOptions) {
    this.workdir = resolve(opts.workdir);
    this.fsyncDir = opts.fsyncDir ?? true;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
    this.staleLockMs = opts.staleLockMs ?? 60_000;
    this.raceWindowMs = opts.raceWindowMs ?? 1_000;
  }

  private resolveSafe(relPath: string, allowEmpty = false): string {
    if (relPath.length === 0) {
      if (allowEmpty) return this.workdir;
      throw new Error("relPath must be non-empty");
    }
    if (relPath.startsWith("/") || relPath.includes(".."))
      throw new Error(`relPath must be relative and free of '..': ${relPath}`);
    const resolved = resolve(this.workdir, relPath);
    if (resolved !== this.workdir && !resolved.startsWith(this.workdir + "/"))
      throw new Error(`relPath escapes workdir: ${relPath}`);
    return resolved;
  }

  async readText(relPath: string): Promise<string | null> {
    const abs = this.resolveSafe(relPath);
    try {
      return await readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeAtomic(relPath: string, content: string): Promise<void> {
    const abs = this.resolveSafe(relPath);
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const tmp = `${abs}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const handle = await open(tmp, "w", 0o644);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, abs);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (this.fsyncDir) await this.syncDir(parent);
  }

  /**
   * Appends a single line. Concurrent appendLine calls *within the same
   * process* are serialized via a per-path promise chain. Cross-process
   * coordination is the caller's responsibility — wrap the read-then-append
   * sequence in withFileLock when multiple processes share the workdir.
   */
  appendLine(relPath: string, content: string): Promise<void> {
    const prev = this.appendChains.get(relPath) ?? Promise.resolve();
    const next = prev.then(
      () => this.appendLineRaw(relPath, content),
      () => this.appendLineRaw(relPath, content),
    );
    this.appendChains.set(
      relPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async appendLineRaw(
    relPath: string,
    content: string,
  ): Promise<void> {
    const abs = this.resolveSafe(relPath);
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const line = content.endsWith("\n") ? content : content + "\n";
    await appendFile(abs, line, "utf8");
    const handle = await open(abs, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async list(relDir: string): Promise<string[]> {
    const abs = this.resolveSafe(relDir, true);
    try {
      return (await readdir(abs))
        .filter((name) => !name.endsWith(".lock"))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    const abs = this.resolveSafe(relPath, true);
    try {
      await stat(abs);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const fromAbs = this.resolveSafe(fromPath);
    const toAbs = this.resolveSafe(toPath);
    await mkdir(dirname(toAbs), { recursive: true });
    // Atomic rename within the same filesystem. POSIX rename overwrites the
    // destination; we explicitly reject collisions to keep the contract clean.
    try {
      await stat(toAbs);
      throw new Error(`move: destination exists: ${toPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await rename(fromAbs, toAbs);
    if (this.fsyncDir) await this.syncDir(dirname(toAbs));
  }

  async withFileLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
    const abs = this.resolveSafe(relPath);
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const lockPath = `${abs}.lock`;
    await this.acquireLock(lockPath);
    try {
      return await fn();
    } finally {
      await this.releaseLock(lockPath);
    }
  }

  private async acquireLock(path: string): Promise<void> {
    const start = Date.now();
    let attempt = 0;
    while (true) {
      try {
        await mkdir(path, { recursive: false });
        const keeper = join(path, LOCK_KEEPER);
        await writeFile(
          keeper,
          JSON.stringify({ pid: process.pid, acquired_at: Date.now() }),
          "utf8",
        );
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      if (await this.tryReclaimStale(path)) continue;
      if (Date.now() - start > this.lockTimeoutMs)
        throw new Error(`withFileLock timeout: ${path}`);
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(50, 5 + attempt * 2)));
    }
  }

  private async tryReclaimStale(lockDir: string): Promise<boolean> {
    const keeper = join(lockDir, LOCK_KEEPER);
    let body: string | null = null;
    try {
      body = await readFile(keeper, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      // Keeper not yet written. Two cases:
      //   (a) lock was stale and abandoned (winner crashed before keeper).
      //   (b) lock just acquired and keeper write is in flight (race window
      //       between mkdir and writeFile). Reclaiming in case (b) makes the
      //       winner's writeFile fail with ENOENT/EINVAL on the parent dir.
      // Distinguish by lockDir age: if the dir was created within
      // raceWindowMs, assume case (b) and back off. After raceWindowMs we
      // assume case (a) — even though staleLockMs has not elapsed, the dir
      // shouldn't have stayed empty for over a second under normal
      // operation, so reclaiming is safer than dead-locking for 60s.
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.ctimeMs < this.raceWindowMs) return false;
      } catch {
        return false;
      }
      try {
        await rmdir(lockDir);
        return true;
      } catch {
        return false;
      }
    }
    let acquiredAt: number;
    try {
      const parsed = JSON.parse(body) as { acquired_at: number };
      acquiredAt = parsed.acquired_at;
    } catch {
      return false;
    }
    if (Date.now() - acquiredAt < this.staleLockMs) return false;
    try {
      await unlink(keeper);
      await rmdir(lockDir);
      return true;
    } catch {
      return false;
    }
  }

  private async releaseLock(path: string): Promise<void> {
    try {
      await unlink(join(path, LOCK_KEEPER)).catch(() => undefined);
      await rmdir(path);
    } catch {
      /* best-effort */
    }
  }

  private async syncDir(dir: string): Promise<void> {
    try {
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* dir fsync not portable; ignore */
    }
  }
}
