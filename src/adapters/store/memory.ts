import type { StorePort } from "../../ports/store.js";

export class MemoryStore implements StorePort {
  private readonly entries = new Map<string, string>();

  async readText(relPath: string): Promise<string | null> {
    return this.entries.get(relPath) ?? null;
  }

  async writeAtomic(relPath: string, content: string): Promise<void> {
    this.entries.set(relPath, content);
  }

  async appendLine(relPath: string, content: string): Promise<void> {
    const line = content.endsWith("\n") ? content : content + "\n";
    const prev = this.entries.get(relPath) ?? "";
    this.entries.set(relPath, prev + line);
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
}
