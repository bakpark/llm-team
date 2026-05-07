export interface ClockPort {
  now(): number;
  isoNow(): string;
}

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  isoNow(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements ClockPort {
  constructor(private millis: number) {}

  now(): number {
    return this.millis;
  }

  isoNow(): string {
    return new Date(this.millis).toISOString();
  }

  advance(deltaMs: number): void {
    this.millis += deltaMs;
  }

  set(millis: number): void {
    this.millis = millis;
  }
}
