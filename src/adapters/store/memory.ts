import type { StorePort } from "../../ports/store.js";

/**
 * In-memory StorePort implementation for tests.
 *
 * appendLine and withFileLock each serialize on a per-path promise chain so
 * that the StorePort contract holds without needing real I/O. The chains are
 * separate so that withFileLock can host appendLine calls without deadlock.
 */
export class MemoryStore implements StorePort {
  private readonly entries = new Map<string, string>();
  private readonly appendChains = new Map<string, Promise<unknown>>();
  private readonly lockChains = new Map<string, Promise<unknown>>();

  async readText(relPath: string): Promise<string | null> {
    return this.entries.get(relPath) ?? null;
  }

  async writeAtomic(relPath: string, content: string): Promise<void> {
    this.entries.set(relPath, content);
  }

  appendLine(relPath: string, content: string): Promise<void> {
    const prev = this.appendChains.get(relPath) ?? Promise.resolve();
    const op = async () => {
      const line = content.endsWith("\n") ? content : content + "\n";
      const cur = this.entries.get(relPath) ?? "";
      this.entries.set(relPath, cur + line);
    };
    const next = prev.then(op, op);
    this.appendChains.set(
      relPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async list(relDir: string): Promise<string[]> {
    const prefix = relDir.endsWith("/") ? relDir : relDir + "/";
    const out = new Set<string>();
    for (const key of this.entries.keys()) {
      if (key === relDir) continue;
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf("/");
        out.add(idx === -1 ? rest : rest.slice(0, idx));
      }
    }
    return Array.from(out).sort();
  }

  async exists(relPath: string): Promise<boolean> {
    if (this.entries.has(relPath)) return true;
    const prefix = relPath.endsWith("/") ? relPath : relPath + "/";
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async withFileLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lockChains.get(relPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.lockChains.set(
      relPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next as Promise<T>;
  }
}
