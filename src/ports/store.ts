export interface StorePort {
  /** Read a single object as raw bytes (utf-8 string). Returns null if missing. */
  readText(relPath: string): Promise<string | null>;

  /**
   * Atomically write the given utf-8 content to relPath via rename-after-write.
   * Implementations must guarantee that observers see either the prior content
   * or the new content — never a partial write.
   */
  writeAtomic(relPath: string, content: string): Promise<void>;

  /**
   * Append a single line (a single ndjson row) to relPath. The implementation
   * serializes concurrent appends via a short-lived lock so that lines do not
   * interleave. A trailing newline is added if `content` does not end with one.
   */
  appendLine(relPath: string, content: string): Promise<void>;

  /** List relative entry names (non-recursive) under relDir. */
  list(relDir: string): Promise<string[]>;

  /** Whether relPath exists (file or dir). */
  exists(relPath: string): Promise<boolean>;
}
