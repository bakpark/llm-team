#!/usr/bin/env node
// echo-stub: read stdin, write argv + stdin to stdout, optionally fail.
// Usage:
//   node echo-stub.mjs [--exit N] [--stderr "msg"] [--sleep S]
import { setTimeout as wait } from "node:timers/promises";

const args = process.argv.slice(2);
let exitCode = 0;
let stderr = "";
let sleepSec = 0;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--exit") exitCode = Number(args[++i] ?? 0);
  else if (a === "--stderr") stderr = String(args[++i] ?? "");
  else if (a === "--sleep") sleepSec = Number(args[++i] ?? 0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");

if (sleepSec > 0) await wait(sleepSec * 1000);

process.stdout.write(JSON.stringify({ argv: args, stdin }) + "\n");
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
