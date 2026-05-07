import { monotonicFactory, ulid } from "ulid";

const monotonic = monotonicFactory();

export type ULID = string;

export function newId(now?: number): ULID {
  return now == null ? ulid() : ulid(now);
}

export function newMonotonicId(now?: number): ULID {
  return now == null ? monotonic() : monotonic(now);
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
