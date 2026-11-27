import { describe, expect, test } from "bun:test";

import {
  lastFrame,
  StreamBuffer,
  stripAnsi,
  stripAnsiIncremental,
  validateSteps,
} from "./omp-pty";

describe("stripAnsi", () => {
  test("removes CSI, OSC, and single-char escapes; keeps text", () => {
    expect(stripAnsi("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(stripAnsi("\x1b[H\x1b[2Jtop")).toBe("top");
    expect(stripAnsi("a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b")).toBe(
      "alinkb",
    );
    expect(stripAnsi("keep\x1b7me")).toBe("keepme");
    expect(stripAnsi("charset \x1b(Bmarker")).toBe("charset marker");
  });

  test("plain text passes through", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});

describe("stripAnsiIncremental", () => {
  test("carries a partial escape across chunks", () => {
    const first = stripAnsiIncremental("hello \x1b[3", "");
    expect(first).toEqual({ stripped: "hello ", carry: "\x1b[3" });

    const second = stripAnsiIncremental("1m world", first.carry);
    expect(second.stripped).toBe(" world");
    expect(second.carry).toBe("");
  });

  test("holds an unterminated OSC and releases it on the terminator", () => {
    const first = stripAnsiIncremental("a\x1b]8;;http://x", "");
    expect(first).toEqual({ stripped: "a", carry: "\x1b]8;;http://x" });

    const second = stripAnsiIncremental("p\x07b", first.carry);
    // "p" completes the OSC URL; only "b" after the BEL is stripped text.
    expect(second.stripped).toBe("b");
    expect(second.carry).toBe("");
  });

  test("chunk with no escapes passes through", () => {
    expect(stripAnsiIncremental("plain", "")).toEqual({
      stripped: "plain",
      carry: "",
    });
  });
});

describe("StreamBuffer", () => {
  test("resolves immediately for an existing substring", async () => {
    const stream = new StreamBuffer();
    stream.push("already here");
    await stream.waitFor("already", 50);
  });

  test("resolves when a later push brings the substring", async () => {
    const stream = new StreamBuffer();
    const pending = stream.waitFor("later", 500);
    stream.push("arrives later now");
    await pending;
  });

  test("rejects on timeout with the awaited substring", async () => {
    const stream = new StreamBuffer();
    stream.push("other");
    const [first, second] = await Promise.all([
      stream.waitFor("missing", 30).catch((e: Error) => e),
      stream.waitFor("missing", 30).catch((e: Error) => e.message),
    ]);
    expect(first).toBeInstanceOf(Error);
    expect(second).toContain('waiting for "missing"');
  });

  test("carried partial escape counts toward the text only when complete", async () => {
    const stream = new StreamBuffer();
    stream.push("part\x1b[3");
    expect(stream.text).toBe("part\x1b[3");
    stream.push("8m done");
    expect(stream.text).toBe("part done");
  });
});

describe("lastFrame", () => {
  test("returns content after the last cursor-home, trailing blanks trimmed", () => {
    const raw =
      "stale\x1b[Hframe one\x1b[31m!\x1b[0m\nnext\n\n\x1b[Hfresh screen\nrow two\n\n\n";
    expect(lastFrame(raw, 40)).toEqual(["fresh screen", "row two"]);
  });

  test("accepts 1;1 home form and caps to rows", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const raw = "\x1b[1;1H" + lines.join("\n") + "\n";
    expect(lastFrame(raw, 3)).toEqual(["l7", "l8", "l9"]);
  });

  test("no home sequence → whole stripped stream", () => {
    expect(lastFrame("plain \x1b[1mtext\x1b[0m\n", 10)).toEqual(["plain text"]);
  });
});

describe("validateSteps", () => {
  test("accepts wait/keys steps", () => {
    const steps = validateSteps([
      { keys: "x" },
      { wait: "prompt", keys: "\r" },
      { wait: "done" },
      { keys: "y", delayMs: 5, timeoutMs: 100 },
    ]);
    expect(steps).toHaveLength(4);
  });

  test("rejects steps without wait, keys, or type", () => {
    expect(() => validateSteps([{}])).toThrow(
      'needs "wait", "keys", or "type"',
    );
    expect(() => validateSteps([1])).toThrow("must be an object");
    expect(() => validateSteps("nope")).toThrow("must be an array");
  });

  test("accepts type steps and rejects type combined with keys", () => {
    expect(
      validateSteps([{ type: "/walkthrough", delayMs: 300 }]),
    ).toHaveLength(1);
    expect(() => validateSteps([{ type: "", wait: "w" }])).toThrow("non-empty");
    expect(() => validateSteps([{ type: "/w", keys: "x" }])).toThrow(
      "not both",
    );
  });

  test("rejects bad numbers", () => {
    expect(() => validateSteps([{ keys: "x", delayMs: -1 }])).toThrow(
      "non-negative",
    );
    expect(() => validateSteps([{ wait: "w", timeoutMs: 0 }])).toThrow(
      "positive",
    );
  });
});

// The pty integration runs through the CLI in a subprocess: each invocation
// owns exactly one Bun.Terminal session, and these tests keep the test
// process itself pty-free.
describe("CLI end to end", () => {
  test("drives bash through the pty and reports the screen", async () => {
    const steps = [
      { wait: "ready" },
      { type: "hi" },
      { keys: "\r" },
      { wait: "got:hi" },
    ];
    const proc = Bun.spawn(
      [
        process.execPath,
        import.meta.dir + "/omp-pty.ts",
        "--steps-json",
        JSON.stringify(steps),
        "--end-keys",
        "",
        "--settle-ms",
        "0",
        "bash",
        "-c",
        "echo ready; read -r x; echo got:$x",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) console.error("CLI stderr:", stderr);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("got:hi");
  }, 20_000);

  test("pty is sized, xterm-256color, and cwd-aware", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        import.meta.dir + "/omp-pty.ts",
        "--cwd",
        "/tmp",
        "--cols",
        "77",
        "--rows",
        "23",
        "--steps-json",
        JSON.stringify([{ wait: "ready" }]),
        "--end-keys",
        "",
        "--settle-ms",
        "0",
        "bash",
        "-c",
        "echo ready; echo cols=$(tput cols) rows=$(tput lines) term=$TERM pwd=$(pwd)",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) console.error("CLI stderr:", stderr);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cols=77 rows=23");
    expect(stdout).toContain("term=xterm-256color");
    expect(stdout).toContain("pwd=/tmp");
  }, 20_000);

  test("step timeout exits 1 with the failure and tail on stderr", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        import.meta.dir + "/omp-pty.ts",
        "--steps-json",
        JSON.stringify([{ wait: "never-appears", timeoutMs: 100 }]),
        "--end-keys",
        "",
        "bash",
        "-c",
        "sleep 1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 1) console.error("CLI stderr:", stderr);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAILED: step 0");
  }, 20_000);
});
