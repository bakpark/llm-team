import { randomBytes } from "node:crypto";

export interface RandomPort {
  hex(byteLength: number): string;
}

export class SystemRandom implements RandomPort {
  hex(byteLength: number): string {
    return randomBytes(byteLength).toString("hex");
  }
}

export class SeededRandom implements RandomPort {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  hex(byteLength: number): string {
    let out = "";
    for (let i = 0; i < byteLength; i++) {
      this.state = (Math.imul(this.state, 1_103_515_245) + 12_345) >>> 0;
      const byte = (this.state >>> 16) & 0xff;
      out += byte.toString(16).padStart(2, "0");
    }
    return out;
  }
}
