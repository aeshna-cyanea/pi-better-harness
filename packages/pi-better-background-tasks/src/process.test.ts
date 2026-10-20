import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandOnce, withSleepInhibit } from "./process.js";

const originalShell = process.env.SHELL;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalShell === undefined) {
    Reflect.deleteProperty(process.env, "SHELL");
  } else {
    process.env.SHELL = originalShell;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("process shell execution", () => {
  // @covers background-task.remote-runner-timeout
  // @level integration
  it("terminates a command that exceeds its run-once timeout", async () => {
    const startedAt = Date.now();

    const result = await runCommandOnce({
      shell: false,
      argv: [process.execPath, "-e", "setInterval(() => {}, 10_000)"],
    }, undefined, 25);

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  // @covers background-task.remote-runner-timeout
  // @level integration
  it("times a command out when its real work outlives the process that was spawned", async () => {
    // The shape the Linux write sandbox produces: `bwrap` forks the command
    // rather than exec'ing it, so the spawned pid is a wrapper and the work —
    // along with the output pipes `close` waits on — belongs to a process a
    // signal to that pid never reaches. Reproduced here with a plain shell,
    // because the defect is in how the timeout terminates, not in bubblewrap.
    const startedAt = Date.now();

    const result = await runCommandOnce({ command: "sleep 30 & wait" }, undefined, 25);

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("uses a deterministic bash-compatible shell instead of the user's login shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bg-shell-"));
    tempDirs.push(dir);
    const fakeShell = join(dir, "fake-shell");
    writeFileSync(fakeShell, "#!/bin/sh\necho unexpected login shell >&2\nexit 42\n");
    chmodSync(fakeShell, 0o755);
    process.env.SHELL = fakeShell;

    const result = await runCommandOnce({ command: "status=ok; printf '%s\\n' \"$status\"" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).not.toContain("unexpected login shell");
  });

  it("counts capture overflow above 1 MiB instead of silently dropping the tail", async () => {
    const result = await runCommandOnce({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1_200_012) + 'END_MARKER')"],
      shell: false,
    });
    expect(result.captureTruncated).toBe(true);
    expect(result.stdoutDiscardedBytes).toBeGreaterThan(1_200_012 - 1024 * 1024);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stdout).not.toContain("END_MARKER");
    expect(result.stdout.startsWith("x")).toBe(true);
  });

  it("discards a code point split across chunks at the cap instead of decoding U+FFFD", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0x61, 0xf0, 0x9f]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80, 0x62])), 60);",
    ].join("");
    const result = await runCommandOnce({ argv: [process.execPath, "-e", script], shell: false }, 4);
    expect(result.stdout).toBe("a");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stdoutDiscardedBytes).toBe(5);
    expect(result.captureTruncated).toBe(true);
  });

  it("does not split a multibyte UTF-8 character at the capture cap", async () => {
    const { utf8PrefixLength } = await import("./process.js");
    const buffer = Buffer.from("é");
    expect(utf8PrefixLength(buffer, 1)).toBe(0);
    expect(utf8PrefixLength(buffer, 2)).toBe(2);
  });
});

const launch = { execPath: "/bin/bash", execArgs: ["-lc", "sleep 5"] };
const linux = { platform: "linux" as const, inhibitAvailable: true };

describe("a task holds its own sleep inhibitor", () => {
  // @covers background-task.sleep-inhibit
  // @level unit
  it("runs the real command after the inhibitor flags, unchanged", () => {
    const wrapped = withSleepInhibit(launch, "background task", { ...linux, setting: true });
    expect(wrapped.execPath).toBe("systemd-inhibit");
    expect(wrapped.execArgs).toEqual([
      "--what=sleep",
      "--who=pi-better-background-tasks",
      "--why=background task",
      "--mode=block",
      "/bin/bash",
      "-lc",
      "sleep 5",
    ]);
  });

  // @covers background-task.sleep-inhibit
  // @level unit
  it("is absent, not failed, where there is no systemd-inhibit to hold a lock", () => {
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      expect(withSleepInhibit(launch, "why", { platform, setting: true, inhibitAvailable: true })).toEqual(launch);
    }
    expect(withSleepInhibit(launch, "why", { platform: "linux", setting: true, inhibitAvailable: false })).toEqual(launch);
  });

  // @covers background-task.sleep-inhibit
  // @level unit
  it("obeys the knob, and fails toward protection when the knob is unreadable", () => {
    for (const off of [false, { enabled: false }]) {
      expect(withSleepInhibit(launch, "why", { ...linux, setting: off })).toEqual(launch);
    }
    // Absent means on, and so does anything this package cannot read: a malformed
    // setting is a configuration mistake, not a licence to suspend mid-task.
    for (const on of [undefined, true, null, { enabled: true }, {}, "no", []]) {
      expect(withSleepInhibit(launch, "why", { ...linux, setting: on }).execPath).toBe("systemd-inhibit");
    }
  });

  // @covers background-task.sleep-inhibit
  // @level integration
  it("really holds the lock for the lifetime of the process it launched", async () => {
    const { existsSync } = await import("node:fs");
    const { delimiter } = await import("node:path");
    const onPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "systemd-inhibit")));
    if (process.platform !== "linux" || !onPath) return;

    // Ask from inside the task's own process tree. The assertion is about *this*
    // task's inhibitor, not about the global list: the suite runs test files in
    // parallel, and other files launch real tasks that hold rows of their own, so
    // "nobody else is holding a lock" is not a fact a test here may rely on.
    const probe = [
      'printf "%s %s %s\\n" "$PPID" "$(ps -o comm= -p "$PPID")"',
      '"$(systemd-inhibit --list --no-pager 2>/dev/null | awk -v p="$PPID" \'$4==p\' | wc -l)"',
    ].join(" ");
    const during = await runCommandOnce({ command: probe });
    expect(during.exitCode).toBe(0);
    const [pidText, parentComm, rowsDuring] = during.stdout.trim().split(/\s+/);
    expect(parentComm).toBe("systemd-inhibit");
    expect(Number(rowsDuring)).toBe(1);
    const pid = Number(pidText);
    expect(Number.isInteger(pid) && pid > 1).toBe(true);

    // The row is gone once the process is, with nothing to clean up by hand. The
    // probe that checks afterwards must not hold a lock of its own, or it counts
    // its own row and proves nothing.
    const after = await runCommandOnce({
      command: `systemd-inhibit --list --no-pager 2>/dev/null | awk -v p=${pid} '$4==p' | wc -l`,
      inhibitSleep: false,
    });
    expect(Number(after.stdout.trim())).toBe(0);
  });

  // @covers background-task.sleep-inhibit
  // @level integration
  it("still stops a task that is wrapped, and leaves no process behind", async () => {
    if (process.platform !== "linux") return;
    const marker = "PI_BG_SURVIVOR_CHECK";
    const result = await runCommandOnce({
      shell: false,
      argv: [process.execPath, "-e", `globalThis.${marker}=1; setInterval(() => {}, 10_000)`],
    }, undefined, 25);
    expect(result.timedOut).toBe(true);
    // The bracket keeps pgrep from matching its own command line, which carries
    // the pattern as text.
    const survivors = await runCommandOnce({
      command: "pgrep -fa '[P]I_BG_SURVIVOR_CHECK' | wc -l",
      inhibitSleep: false,
    });
    expect(Number(survivors.stdout.trim())).toBe(0);
  });
});
