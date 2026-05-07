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
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { StorePort } from "../../ports/store.js";

export interface FsStoreOptions {
  /** Absolute path to workdir root. All relPaths resolve under this. */
  workdir: string;
  /** Whether to fsync the parent directory after rename. Default true. */
  fsyncDir?: boolean;
}

export class FsStore implements StorePort {
  private readonly workdir: string;
  private readonly fsyncDir: boolean;

  constructor(opts: FsStoreOptions) {
    this.workdir = resolve(opts.workdir);
    this.fsyncDir = opts.fsyncDir ?? true;
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

  async appendLine(relPath: string, content: string): Promise<void> {
    const abs = this.resolveSafe(relPath);
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const lockPath = `${abs}.lock`;
    await this.acquireLock(lockPath);
    try {
      const line = content.endsWith("\n") ? content : content + "\n";
      await appendFile(abs, line, "utf8");
      const handle = await open(abs, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      await this.releaseLock(lockPath);
    }
  }

  async list(relDir: string): Promise<string[]> {
    const abs = this.resolveSafe(relDir, true);
    try {
      return (await readdir(abs)).sort();
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

  private async acquireLock(path: string): Promise<void> {
    const start = Date.now();
    const timeoutMs = 5000;
    let attempt = 0;
    while (true) {
      try {
        await mkdir(path, { recursive: false });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() - start > timeoutMs)
          throw new Error(`appendLine lock timeout: ${path}`);
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(50, 5 + attempt * 2)));
      }
    }
  }

  private async releaseLock(path: string): Promise<void> {
    try {
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
