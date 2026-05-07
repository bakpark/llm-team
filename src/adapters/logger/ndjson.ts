import type { ClockPort } from "../../ports/clock.js";
import type { LogEvent, LoggerPort } from "../../ports/logger.js";
import type { StorePort } from "../../ports/store.js";

export interface NdjsonLoggerOptions {
  store: StorePort;
  clock: ClockPort;
  /** Path inside workdir for the ndjson log file. */
  relPath: string;
}

export class NdjsonLogger implements LoggerPort {
  private readonly store: StorePort;
  private readonly clock: ClockPort;
  private readonly relPath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: NdjsonLoggerOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.relPath = opts.relPath;
  }

  log(event: LogEvent): void {
    const row = {
      ts: this.clock.isoNow(),
      level: event.level,
      event: event.event,
      ...(event.fields ?? {}),
    };
    const line = JSON.stringify(row);
    this.chain = this.chain.then(() =>
      this.store.appendLine(this.relPath, line).catch(() => {
        /* logger must not throw */
      }),
    );
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
