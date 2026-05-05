#!/usr/bin/env node
// envelope-emitter: read stdin (the 4-part prompt), echo a minimal envelope
// in a ```json fenced block to stdout, then exit 0.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");

const argv = process.argv.slice(2);

const envelope = {
  argv,
  prompt_bytes: stdin.length,
  ok: true,
};

process.stdout.write("```json\n");
process.stdout.write(JSON.stringify(envelope));
process.stdout.write("\n```\n");
process.exit(0);
