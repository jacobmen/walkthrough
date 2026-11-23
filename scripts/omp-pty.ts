#!/usr/bin/env bun
/**
 * Drive omp (or any TUI command) in a real pty.
 *
 * Usage:
 *   bun scripts/omp-pty.ts [--cwd DIR] [--cols N] [--rows N] [--log FILE]
 *       [--steps FILE.json] [--steps-json '<json>'] [--step-timeout MS]
 *       [--deadline MS] [--end-keys KEYS] [--settle-ms MS] [--] [command args...]
 *
 * Steps: one JSON object per action.
 *   {"wait": "<substring>", "keys": "<keys>"}
 *   - `wait` is matched against ANSI-stripped stream text; keys are sent only
 *     after it matches (adaptive — avoids racing a still-booting TUI).
 *   - Keys sent before the child is ready can be lost: make the FIRST step
 *     wait for a boot/ready marker before sending anything.
 *   - `keys` alone (no `wait`): sent after `delayMs` (default 0).
 *   - `wait` alone: assertion only, nothing sent.
 *   - `type`: like `keys` but one character per write with a 20ms gap —
 *     per-key handling (slash-command autocomplete) never sees a burst, so a
 *     command sent as one write never opens its popup. Mutually exclusive
 *     with `keys`.
 *   - `delayMs`: extra settle delay after `wait` matches, before keys.
 *   - `timeoutMs`: budget for this step's `wait` (default --step-timeout).
 * On completion the final screen is printed; the raw stream (with escapes) is
 * written to --log for replay. On timeout the stripped tail is printed.
 *
 * Runs exactly one pty session per process (one Bun.Terminal per child);
 * earlier transports degraded under concurrent sessions, so drive sessions
 * serially, one CLI invocation each.
 *
 * Example (walkthrough smoke):
 *   bun scripts/omp-pty.ts --steps-json '[
 *     {"wait":"walkthrough"},
 *     {"keys":"/walkthrough","delayMs":300},
 *     {"wait":"%─","timeoutMs":20000},
 *     {"keys":"\r"},
 *     {"wait":"walkthrough · unstaged changes","keys":"d"}]'
 *
 * The "%─" wait anchors on the status-bar context indicator, which renders
 * late in boot; an Enter sent before it is swallowed by omp's bootstrap
 * submit gate. A burst-typed registered command still executes — omp's
 * sync-completion path applies it on Enter — but per-key TUI behavior such
 * as autocomplete popups needs the `type` step, which sends characters
 * individually.
 */

import { readFileSync } from "node:fs";

export type Step = {
  wait?: string;
  keys?: string;
  /** Sent one character per write with a 20ms gap, like a human typing. */
  type?: string;
  delayMs?: number;
  timeoutMs?: number;
};

const ANSI =
  /\x1b(?:\[[0-9:;<=>?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|(?![[\]^_PX])[ -/]*[\x30-\x7e])/g;
const COMPLETE_SEQ = new RegExp(ANSI.source, "");
const PARTIAL_SEQ = /^\x1b(?:$|[ -/]*$|\[[0-9:;<=>?]*[ -/]*$|\][^\x07\x1b]*)/;

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI, "");
}

/** Strips complete ANSI sequences, holding back a trailing partial one. */
export function stripAnsiIncremental(
  chunk: string,
  carry: string,
): { stripped: string; carry: string } {
  const joined = carry + chunk;
  const esc = joined.lastIndexOf("\x1b");
  if (esc === -1) return { stripped: stripAnsi(joined), carry: "" };
  const head = stripAnsi(joined.slice(0, esc));
  const tail = joined.slice(esc);
  if (COMPLETE_SEQ.test(tail))
    return { stripped: head + stripAnsi(tail), carry: "" };
  if (PARTIAL_SEQ.test(tail)) return { stripped: head, carry: tail };
  return { stripped: head, carry: "" };
}

/** Terminal stream with ANSI stripped incrementally, for wait matching. */
export class StreamBuffer {
  #stripped = "";
  #carry = "";
  #raw = "";
  #listeners = new Set<() => void>();

  push(chunk: string): void {
    this.#raw += chunk;
    const { stripped, carry } = stripAnsiIncremental(chunk, this.#carry);
    this.#carry = carry;
    this.#stripped += stripped;
    for (const listener of this.#listeners) listener();
  }

  get text(): string {
    return this.#stripped + this.#carry;
  }

  get rawText(): string {
    return this.#raw;
  }

  waitFor(substring: string, timeoutMs: number): Promise<void> {
    if (this.text.includes(substring)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.text.includes(substring)) {
          clearTimeout(timer);
          this.#listeners.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.#listeners.delete(check);
        reject(
          new Error(
            `timeout after ${timeoutMs}ms waiting for ${JSON.stringify(substring)}`,
          ),
        );
      }, timeoutMs);
      this.#listeners.add(check);
    });
  }
}

/** Last full-frame redraw, ANSI-stripped: a readable approximation of the screen. */
export function lastFrame(raw: string, rows: number): string[] {
  const homes = [...raw.matchAll(/\x1b\[(?:1;1)?[Hf]/g)];
  const last = homes.at(-1);
  const start = last ? last.index + last[0].length : 0;
  const lines = stripAnsi(raw.slice(start))
    .split(/\r?\n/)
    .map((line) => line.replaceAll("\r", ""));
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.slice(-rows);
}

export type SessionOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

export class PtySession {
  readonly stream = new StreamBuffer();
  readonly #proc: Bun.Subprocess;
  readonly #terminal: Bun.Terminal;
  #exitCode: number | null = null;
  #exited = false;
  readonly #exitPromise: Promise<void>;
  readonly #ptyEof: Promise<void>;

  constructor(options: SessionOptions) {
    const decoder = new TextDecoder();
    const { promise: ptyEof, resolve: resolveEof } =
      Promise.withResolvers<void>();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
    };
    env["TERM"] = options.env?.["TERM"] ?? "xterm-256color";
    const proc = Bun.spawn([options.command, ...(options.args ?? [])], {
      cwd: options.cwd ?? process.cwd(),
      env,
      terminal: {
        cols: options.cols ?? 100,
        rows: options.rows ?? 40,
        data: (_terminal, data) => {
          this.stream.push(decoder.decode(data, { stream: true }));
        },
        exit: () => {
          this.stream.push(decoder.decode());
          resolveEof();
        },
      },
    });
    const terminal = proc.terminal;
    if (!terminal) throw new Error("spawn did not attach a pty");
    this.#proc = proc;
    this.#terminal = terminal;
    this.#ptyEof = ptyEof;
    this.#exitPromise = (async () => {
      await proc.exited;
      this.#exitCode = proc.exitCode;
      this.#exited = true;
    })();
  }

  get exited(): boolean {
    return this.#exited;
  }

  write(data: string): void {
    if (this.#terminal.closed) return;
    this.#terminal.write(data);
  }

  /** Waits for exit up to `graceMs`, then SIGKILLs the child. */
  async exit(graceMs = 3000): Promise<number> {
    const timer = setTimeout(() => this.#proc.kill("SIGKILL"), graceMs);
    try {
      await this.#exitPromise;
      // Trailing output normally precedes exit; give the pty EOF a bounded
      // window so the final frame lands in the stream before capture.
      await Promise.race([this.#ptyEof, Bun.sleep(250)]);
    } finally {
      clearTimeout(timer);
    }
    this.#close();
    return this.#exitCode ?? -1;
  }

  kill(): void {
    if (this.#exited) return;
    this.#proc.kill("SIGKILL");
    this.#close();
  }

  #close(): void {
    if (!this.#terminal.closed) this.#terminal.close();
  }
}

export type RunOptions = SessionOptions & {
  steps: Step[];
  stepTimeoutMs?: number;
  deadlineMs?: number;
  settleMs?: number;
  endKeys?: string;
};

export type RunResult = {
  raw: string;
  screen: string[];
  exitCode: number;
  /** Set when a step timed out or the deadline hit; the session was killed. */
  error?: string;
};

export async function runPtySession(options: RunOptions): Promise<RunResult> {
  const rows = options.rows ?? 40;
  const session = new PtySession(options);
  const runner = (async () => {
    for (const [index, step] of options.steps.entries()) {
      if (step.wait !== undefined) {
        try {
          await session.stream.waitFor(
            step.wait,
            step.timeoutMs ?? options.stepTimeoutMs ?? 15_000,
          );
        } catch (err) {
          throw new Error(
            `step ${index}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if ((step.delayMs ?? 0) > 0) await Bun.sleep(step.delayMs!);
      if (step.type !== undefined) {
        // Separate writes keep each keystroke its own read chunk; a
        // coalesced burst skips per-key handling like slash autocomplete.
        for (const ch of step.type) {
          session.write(ch);
          await Bun.sleep(20);
        }
      } else if (step.keys !== undefined) {
        session.write(step.keys);
      }
    }
    const settleMs = options.settleMs ?? 500;
    if (settleMs > 0) await Bun.sleep(settleMs);
    const endKeys = options.endKeys ?? "\x03\x03";
    if (endKeys.length > 0) session.write(endKeys);
  })();

  const deadline = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("session deadline exceeded")),
      options.deadlineMs ?? 120_000,
    ).unref();
  });

  let error: string | undefined;
  try {
    await Promise.race([runner, deadline]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const exitCode =
    error === undefined ? await session.exit() : (session.kill(), -1);

  const base = {
    raw: session.stream.rawText,
    screen: lastFrame(session.stream.rawText, rows),
    exitCode,
  };
  return error === undefined ? base : { ...base, error };
}

const USAGE = `
Usage: bun scripts/omp-pty.ts [--cwd DIR] [--cols N] [--rows N] [--log FILE]
    [--steps FILE.json] [--steps-json '<json>'] [--step-timeout MS]
    [--deadline MS] [--end-keys KEYS] [--settle-ms MS] [--] [command args...]

Steps JSON: array of {"wait"?: string, "keys"?: string, "type"?: string, "delayMs"?: number, "timeoutMs"?: number}
Each step needs a "wait", "keys", or "type". Screen size defaults to 100x40.
`;

export function validateSteps(steps: unknown): Step[] {
  if (!Array.isArray(steps)) throw new Error("steps must be an array");
  return steps.map((step, index) => {
    if (typeof step !== "object" || step === null)
      throw new Error(`step ${index} must be an object`);
    const { wait, keys, type, delayMs, timeoutMs } = step as Record<
      string,
      unknown
    >;
    if (wait === undefined && keys === undefined && type === undefined)
      throw new Error(`step ${index} needs "wait", "keys", or "type"`);
    if (wait !== undefined && typeof wait !== "string")
      throw new Error(`step ${index}: "wait" must be a string`);
    if (keys !== undefined && typeof keys !== "string")
      throw new Error(`step ${index}: "keys" must be a string`);
    if (type !== undefined && (typeof type !== "string" || type.length === 0))
      throw new Error(`step ${index}: "type" must be a non-empty string`);
    if (keys !== undefined && type !== undefined)
      throw new Error(`step ${index}: use "keys" or "type", not both`);
    if (delayMs !== undefined && (typeof delayMs !== "number" || delayMs < 0))
      throw new Error(`step ${index}: "delayMs" must be a non-negative number`);
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || timeoutMs <= 0)
    )
      throw new Error(`step ${index}: "timeoutMs" must be a positive number`);
    return step as Step;
  });
}

type Config = RunOptions & { logPath: string };

function number(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive number`);
  return parsed;
}

function nonNegative(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    command: "omp",
    args: [],
    steps: [],
    logPath: `/tmp/omp-pty-${Date.now()}.log`,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      if (++i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i]!;
    };
    switch (arg) {
      case "--cwd":
        config.cwd = next();
        break;
      case "--cols":
        config.cols = number(next(), arg);
        break;
      case "--rows":
        config.rows = number(next(), arg);
        break;
      case "--log":
        config.logPath = next();
        break;
      case "--steps": {
        const file = next();
        config.steps = validateSteps(JSON.parse(readFileSync(file, "utf8")));
        break;
      }
      case "--steps-json":
        config.steps = validateSteps(JSON.parse(next()));
        break;
      case "--step-timeout":
        config.stepTimeoutMs = number(next(), arg);
        break;
      case "--deadline":
        config.deadlineMs = number(next(), arg);
        break;
      case "--end-keys":
        config.endKeys = next();
        break;
      case "--settle-ms":
        config.settleMs = nonNegative(next(), arg);
        break;
      case "--":
        rest.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        rest.push(arg);
    }
  }
  if (config.steps.length === 0)
    throw new Error("no steps: pass --steps or --steps-json");
  if (rest.length > 0) {
    config.command = rest[0]!;
    config.args = rest.slice(1);
  }
  return config;
}

async function main(): Promise<number> {
  let config: Config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.stderr.write(USAGE);
    return 2;
  }

  let result: RunResult;
  try {
    result = await runPtySession(config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
  await Bun.write(config.logPath, result.raw);
  if (result.error !== undefined) {
    console.error(`FAILED: ${result.error}`);
    const tail = stripAnsi(result.raw).split(/\r?\n/).slice(-40).join("\n");
    console.error(`--- stripped tail ---\n${tail}`);
  } else if (result.exitCode > 0) {
    console.error(`command exited with code ${result.exitCode}`);
  }
  console.log(result.screen.join("\n"));
  console.error(`raw stream: ${config.logPath}`);
  return result.error !== undefined ? 1 : Math.max(0, result.exitCode);
}

if (import.meta.main) process.exit(await main());
