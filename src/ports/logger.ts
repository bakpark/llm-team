export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export interface LoggerPort {
  log(event: LogEvent): void;
}

export class NullLogger implements LoggerPort {
  log(_event: LogEvent): void {
    /* no-op */
  }
}

export class CollectingLogger implements LoggerPort {
  readonly events: LogEvent[] = [];

  log(event: LogEvent): void {
    this.events.push(event);
  }
}
