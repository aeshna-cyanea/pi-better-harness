import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const targets = [
  "packages/pi-better-background-tasks/src/shared-log-utils.ts",
  "packages/pi-better-subagents/shared-log-utils.ts",
];

// The bug: a retained log carries two writers. The harness appends separator
// lines, and the task's own stdout is appended verbatim with whatever clock the
// program inside the task prints (usually local wall-clock). A bare
// `toISOString()` separator is then read against that local output as a
// different time base, and the reader invents elapsed time that never happened.
// Observed in the wild: a task whose last own line was `18:17:37.328` followed
// by `--- exit 2026-10-12T01:17:37.336Z ---` — 8 ms apart, read as seven hours,
// and reported as a task that "completed twice at different times".

test("logTimestamp names both clocks so a separator cannot be misread", async () => {
  const utils = await import(resolve(root, targets[0]));
  const at = new Date("2026-10-12T01:17:37.336Z");
  const line = utils.logTimestamp(at);
  assert.match(line, /^2026-10-12T01:17:37\.336Z \(.+\)$/, line);
  // The parenthesised half must be the same instant expressed locally, with a
  // zone label — never a bare, unlabelled time.
  const local = line.match(/\((.+)\)$/)[1];
  assert.notEqual(local, at.toISOString());
  assert.match(local, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, local);
  assert.match(local, /\S+ \S+$/, `zone label required: ${local}`);
  // Accepting epoch ms and Date must agree.
  assert.equal(utils.logTimestamp(at.getTime()), utils.logTimestamp(at));
});

test("logTimestamp's local half is the same instant, not a shifted one", async () => {
  const utils = await import(resolve(root, targets[0]));
  const at = new Date("2026-10-12T01:17:37.336Z");
  const local = utils.logTimestamp(at).match(/\((.+?)\)$/)[1];
  const [datePart, timePart] = local.split(" ");
  // Parsing the printed wall-clock as local time must land back on the instant.
  const printedAsLocal = new Date(`${datePart}T${timePart}`);
  assert.ok(Math.abs(printedAsLocal.getTime() - at.getTime()) < 1000,
    `printed local "${local}" should be within 1 s of ${at.toISOString()}`);
});

test("background-task log separators use logTimestamp, not a bare UTC clock", () => {
  const dir = resolve(root, "packages/pi-better-background-tasks/src");
  for (const file of ["process.ts", "logs.ts", "runtime.ts"]) {
    const source = readFileSync(resolve(dir, file), "utf8");
    const separators = source.split("\n").filter((line) => /--- (spawn|exit|check|watch|poll error|remote tmux bootstrap)/.test(line));
    assert.ok(separators.length > 0, `${file}: expected separator lines`);
    for (const line of separators) {
      assert.match(line, /logTimestamp\(/, `${file}: ${line.trim()}`);
      assert.doesNotMatch(line, /new Date\([^)]*\)\.toISOString\(\)/, `${file}: ${line.trim()}`);
    }
  }
});

test("vendored log-utils copies stay identical after adding the helper", () => {
  const source = readFileSync(resolve(root, "packages/log-utils/index.ts"), "utf8");
  const banner = "// Generated from packages/log-utils/index.ts. Do not edit directly.\n";
  for (const target of targets) {
    assert.equal(readFileSync(resolve(root, target), "utf8"), `${banner}${source}`, target);
  }
});
