import { describe, expect, test } from "bun:test";

import { visibleWidth } from "@oh-my-pi/pi-tui";

import type { DiffFile } from "./diff";
import type { HelpOverlay } from "./help-overlay";
import { buildPrompt } from "./prompt";
import { countComments } from "./review-model";
import {
  add,
  binaryFile,
  fakeTui,
  identityTheme,
  textFile,
} from "./test-fixtures";
import { type NonEmpty, WalkthroughViewer } from "./viewer";

/** Two text files of two `add` lines each. Cursor rows: alpha, beta, gamma, delta. */
function makeViewer() {
  const lines = [
    add("alpha", 1),
    add("beta", 2),
    add("gamma", 1),
    add("delta", 2),
  ];
  const files: NonEmpty<DiffFile> = [
    textFile("a.ts", [{ header: "@@ -1,2 +1,2 @@", lines: lines.slice(0, 2) }]),
    textFile("b.ts", [{ header: "@@ -1,2 +1,2 @@", lines: lines.slice(2) }]),
  ];

  const { tui, renderCount, overlays } = fakeTui(40);
  let doneCalls = 0;

  const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {
    doneCalls++;
  });

  return {
    viewer,
    files,
    lines,
    renderCount,
    overlays,
    doneCalls: () => doneCalls,
  };
}

function annotate(viewer: WalkthroughViewer, text: string): void {
  viewer.handleInput("a");
  for (const ch of text) viewer.handleInput(ch);
  viewer.handleInput("\r");
}

describe("cursor movement and annotate", () => {
  test("j moves down; comment lands on the moved-to line", () => {
    const v = makeViewer();

    v.viewer.handleInput("j");
    annotate(v.viewer, "c1");

    expect(v.lines[1]!.comment).toBe("c1");
    expect(v.lines[0]!.comment).toBeUndefined();
  });

  test("down arrow moves down", () => {
    const v = makeViewer();

    v.viewer.handleInput("\x1b[B");
    annotate(v.viewer, "c1");

    expect(v.lines[1]!.comment).toBe("c1");
  });

  test("k moves back up; up arrow stays at the top", () => {
    const v = makeViewer();

    v.viewer.handleInput("j");
    v.viewer.handleInput("k");
    annotate(v.viewer, "top");

    expect(v.lines[0]!.comment).toBe("top");

    const w = makeViewer();

    w.viewer.handleInput("\x1b[A");
    annotate(w.viewer, "top");

    expect(w.lines[0]!.comment).toBe("top");
  });

  test("j clamps at the last line of the current file", () => {
    const v = makeViewer();

    for (let i = 0; i < 10; i++) v.viewer.handleInput("j");
    annotate(v.viewer, "last");

    expect(v.lines[1]!.comment).toBe("last");
    expect(v.lines[3]!.comment).toBeUndefined();
  });

  test("annotate prompt shows the target line number", () => {
    const v = makeViewer();

    v.viewer.handleInput("j"); // beta → L2
    v.viewer.handleInput("a");

    expect(v.viewer.render(80).at(-1)).toContain("annotate L2:");
  });
});

describe("file switch", () => {
  test("n shows the next file's first line, p back", () => {
    const v = makeViewer();

    v.viewer.handleInput("n");
    annotate(v.viewer, "c2");

    expect(v.lines[2]!.comment).toBe("c2");

    v.viewer.handleInput("p");
    annotate(v.viewer, "c1");

    expect(v.lines[0]!.comment).toBe("c1");
    expect(v.lines[2]!.comment).toBe("c2");
  });

  test("n/p swap the rendered file", () => {
    const v = makeViewer();

    const before = v.viewer.render(80);
    expect(before[1]).toContain("[1/2] a.ts");
    expect(before.some((line) => line.includes("b.ts"))).toBe(false);

    v.viewer.handleInput("n");
    const after = v.viewer.render(80);
    expect(after[1]).toContain("[2/2] b.ts");
    expect(after.some((line) => line.includes("a.ts"))).toBe(false);

    v.viewer.handleInput("p");
    expect(v.viewer.render(80)[1]).toContain("[1/2] a.ts");
  });

  test("wraps at both ends", () => {
    const v = makeViewer();

    v.viewer.handleInput("p"); // a.ts → wraps to b.ts
    expect(v.viewer.render(80)[1]).toContain("[2/2] b.ts");

    v.viewer.handleInput("n"); // back to a.ts
    v.viewer.handleInput("n"); // a.ts → b.ts
    v.viewer.handleInput("n"); // wraps to a.ts
    expect(v.viewer.render(80)[1]).toContain("[1/2] a.ts");
  });

  test("first visit to a file starts at its first line", () => {
    const v = makeViewer();

    v.viewer.handleInput("j"); // a.ts: beta (index 1)
    v.viewer.handleInput("n"); // b.ts: never visited, starts at gamma (index 0)
    annotate(v.viewer, "g");

    expect(v.lines[2]!.comment).toBe("g");
    expect(v.lines[3]!.comment).toBeUndefined();
  });

  test("n/p on a single file do nothing and request no render", () => {
    const lines = Array.from({ length: 3 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("only.ts", [{ header: "@@", lines }]),
    ];
    const { tui, renderCount } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("j"); // move within the single file
    const before = renderCount();
    viewer.handleInput("n");
    viewer.handleInput("p");

    expect(renderCount()).toBe(before);
    annotate(viewer, "c");
    expect(lines[1]!.comment).toBe("c"); // cursor unaffected by the no-op switches
    expect(viewer.render(80)[1]).toContain("[1/1] only.ts");
  });
});

describe("cursor position restore across file switches", () => {
  test("returning to a file restores its cursor position", () => {
    const v = makeViewer();

    v.viewer.handleInput("j"); // a.ts: beta
    v.viewer.handleInput("n"); // b.ts: gamma (first visit)
    annotate(v.viewer, "b");
    v.viewer.handleInput("p"); // back to a.ts
    annotate(v.viewer, "a");

    expect(v.lines[1]!.comment).toBe("a"); // beta, not alpha
    expect(v.lines[2]!.comment).toBe("b"); // gamma, untouched
  });

  test("position survives several intervening switches and wraps back around", () => {
    const lines = [
      add("alpha", 1),
      add("beta", 2),
      add("gamma", 1),
      add("delta", 2),
      add("epsilon", 1),
      add("zeta", 2),
    ];
    const files: NonEmpty<DiffFile> = [
      textFile("a.ts", [
        { header: "@@ -1,2 +1,2 @@", lines: lines.slice(0, 2) },
      ]),
      textFile("b.ts", [
        { header: "@@ -1,2 +1,2 @@", lines: lines.slice(2, 4) },
      ]),
      textFile("c.ts", [{ header: "@@ -1,2 +1,2 @@", lines: lines.slice(4) }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.handleInput("j"); // a.ts: beta
    viewer.handleInput("n"); // b.ts: gamma (first visit)
    annotate(viewer, "b");
    viewer.handleInput("n"); // c.ts: epsilon (first visit)
    annotate(viewer, "c");
    viewer.handleInput("n"); // wraps back to a.ts
    annotate(viewer, "a");

    expect(lines[1]!.comment).toBe("a"); // beta restored
    expect(lines[2]!.comment).toBe("b");
    expect(lines[4]!.comment).toBe("c");
  });

  test("returning to a scrolled file restores the exact visible window", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
      textFile("small.ts", [{ header: "@@", lines: [add("small", 1)] }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80); // bodyRows = 37
    for (let i = 0; i < 40; i++) viewer.handleInput("j"); // cursor to row 40
    viewer.render(80); // scrollIntoView moves the offset to 4
    viewer.handleInput("k"); // cursor 39; offset stays 4
    const before = viewer.render(80);

    viewer.handleInput("n"); // small.ts: first visit, cursor 0
    viewer.render(80);
    viewer.handleInput("p"); // back to big.ts
    const after = viewer.render(80);

    expect(after[1]).toContain("[1/2] big.ts");
    expect(after.slice(2, 39)).toEqual(before.slice(2, 39));
    expect(after[2]).toContain("line4"); // offset 4 kept, not recomputed from 0
    expect(after[38]).toContain("line40");
  });

  test("binary files keep cursor 0 and do not crash when switching", () => {
    const lines = [add("alpha", 1), add("beta", 2)];
    const files: NonEmpty<DiffFile> = [
      textFile("a.ts", [{ header: "@@", lines }]),
      binaryFile("logo.png"),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("j"); // a.ts: beta
    viewer.handleInput("n"); // logo.png: no cursor rows, cursor stays 0
    viewer.handleInput("j"); // no-op on binary

    const binary = viewer.render(80);
    expect(binary[1]).toContain("[2/2] logo.png");
    expect(binary[2]).toContain("binary file — not displayed");

    viewer.handleInput("p"); // back to a.ts
    annotate(viewer, "a");
    expect(lines[1]!.comment).toBe("a"); // beta restored
  });
});

describe("page keys", () => {
  test("ctrl+f advances one viewport of body rows (render(80) sets 37), with a render request", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui, renderCount } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80); // viewportRows = 38 → bodyRows = 37
    const before = renderCount();
    viewer.handleInput("\x06"); // ctrl+f: +37 rows

    expect(renderCount()).toBe(before + 1);

    annotate(viewer, "pd");

    expect(lines[37]!.comment).toBe("pd");
    expect(lines[37]!.newLine).toBe(38);
  });

  test("ctrl+b goes back one viewport", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("\x06");
    viewer.handleInput("\x02"); // ctrl+b: -37 rows

    annotate(viewer, "pu");

    expect(lines[0]!.comment).toBe("pu");
  });

  test("ctrl+d advances half a viewport (half of 37 = 18), with a render request, and not done", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui, renderCount } = fakeTui(40);
    let doneCalls = 0;
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {
      doneCalls++;
    });

    viewer.render(80); // viewportRows = 38 → bodyRows = 37, half = 18
    const before = renderCount();
    viewer.handleInput("\x04"); // ctrl+d

    expect(renderCount()).toBe(before + 1);
    expect(doneCalls).toBe(0);

    annotate(viewer, "cd");

    expect(lines[18]!.comment).toBe("cd");
    expect(lines[18]!.newLine).toBe(19);
  });

  test("three ctrl+d scroll the content: line38 in, line0 out", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");

    const out = viewer.render(80);

    expect(out.some((line) => line.includes("line38"))).toBe(true);
    expect(out.some((line) => line.includes("line0"))).toBe(false);
  });

  test("ctrl+d four times clamps at the last cursor row", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");

    annotate(viewer, "cd");

    expect(lines[49]!.comment).toBe("cd");
  });

  test("ctrl+u scrolls back up; two presses undo two and line0 is back on screen", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("\x04");
    viewer.handleInput("\x04");
    viewer.handleInput("\x15"); // ctrl+u
    viewer.handleInput("\x15");

    annotate(viewer, "cu");

    const out = viewer.render(80);

    expect(lines[0]!.comment).toBe("cu");
    expect(out.some((line) => line.includes("line0"))).toBe(true);
  });
});

describe("annotate prompt lifecycle", () => {
  test("escape closes the prompt without saving", () => {
    const v = makeViewer();
    const before = v.renderCount();

    v.viewer.handleInput("a");
    v.viewer.handleInput("c");
    v.viewer.handleInput("1");
    v.viewer.handleInput("\x1b");

    expect(v.lines[0]!.comment).toBeUndefined();
    expect(v.renderCount()).toBeGreaterThan(before);

    // Prompt closed: j moves the cursor again instead of typing into the input.
    v.viewer.handleInput("j");
    annotate(v.viewer, "c2");

    expect(v.lines[1]!.comment).toBe("c2");
  });

  test("annotating a commented line prefills; untouched submit keeps the comment", () => {
    const v = makeViewer();
    annotate(v.viewer, "keep me");

    v.viewer.handleInput("a"); // input prefilled with "keep me"
    v.viewer.handleInput("\r"); // submit untouched

    expect(v.lines[0]!.comment).toBe("keep me");
  });

  test("submitting an emptied value deletes an existing comment", () => {
    const v = makeViewer();
    annotate(v.viewer, "keep me");

    v.viewer.handleInput("a");
    for (let i = 0; i < 10; i++) v.viewer.handleInput("\x7f"); // backspace
    v.viewer.handleInput("\r");

    expect(v.lines[0]!.comment).toBeUndefined();
  });
});

describe("finish and discard", () => {
  test("d finishes immediately even with comments", () => {
    const v = makeViewer();
    annotate(v.viewer, "c1");

    v.viewer.handleInput("d");

    expect(v.doneCalls()).toBe(1);
  });

  test("q with no comments finishes immediately", () => {
    const v = makeViewer();

    v.viewer.handleInput("q");

    expect(v.doneCalls()).toBe(1);
  });

  test("q with comments asks; y discards every comment and finishes", () => {
    const v = makeViewer();
    annotate(v.viewer, "c1");

    v.viewer.handleInput("q");

    expect(v.doneCalls()).toBe(0);
    expect(v.viewer.render(80)[0]).toContain("Discard 1 comments? y/n");

    v.viewer.handleInput("y");

    expect(v.doneCalls()).toBe(1);
    expect(countComments(v.files)).toBe(0);
  });

  test("n at the confirmation prompt keeps comments", () => {
    const v = makeViewer();
    annotate(v.viewer, "c1");

    v.viewer.handleInput("q");
    v.viewer.handleInput("n");

    expect(v.doneCalls()).toBe(0);
    expect(countComments(v.files)).toBe(1);
    expect(v.viewer.render(80)[0]).toContain("? for help");
  });

  test("escape at the confirmation prompt keeps comments", () => {
    const v = makeViewer();
    annotate(v.viewer, "c1");

    v.viewer.handleInput("q");
    v.viewer.handleInput("\x1b");

    expect(v.doneCalls()).toBe(0);
    expect(countComments(v.files)).toBe(1);
  });
});

describe("ignored keys", () => {
  test("unbound key: no cursor move, no render", () => {
    const v = makeViewer();
    const before = v.renderCount();

    v.viewer.handleInput("x");

    expect(v.renderCount()).toBe(before);

    annotate(v.viewer, "c1"); // cursor never moved off the first line
    expect(v.lines[0]!.comment).toBe("c1");
  });
});

describe("gg and G jumps", () => {
  test("G jumps to the last line of the current file", () => {
    const v = makeViewer();

    v.viewer.handleInput("G");
    annotate(v.viewer, "last");

    expect(v.lines[1]!.comment).toBe("last");
    expect(v.lines[3]!.comment).toBeUndefined();
  });

  test("gg jumps to the first line", () => {
    const v = makeViewer();

    v.viewer.handleInput("j");
    v.viewer.handleInput("g");
    v.viewer.handleInput("g");
    annotate(v.viewer, "top");

    expect(v.lines[0]!.comment).toBe("top");
  });

  test("lone g shows the pending indicator and requests a render", () => {
    const v = makeViewer();
    const before = v.renderCount();

    v.viewer.handleInput("g");

    expect(v.renderCount()).toBe(before + 1);
    const out = v.viewer.render(80);
    expect(out[0]!.endsWith("g")).toBe(true);
    expect(out[0]!.length).toBe(80);

    v.viewer.handleInput("x"); // dropped, resets pending; cursor never moved
    annotate(v.viewer, "c1"); // cursor never moved off the first line
    expect(v.lines[0]!.comment).toBe("c1");
  });

  test("a key after g that is not g is dropped", () => {
    const v = makeViewer();

    v.viewer.handleInput("j"); // beta
    v.viewer.handleInput("g");
    v.viewer.handleInput("a"); // dropped: pending reset, no annotate prompt

    expect(v.viewer.render(80).at(-2)).not.toContain("annotate L");

    annotate(v.viewer, "c"); // a works again after the reset
    expect(v.lines[1]!.comment).toBe("c");
  });

  test("pending g resets after a completed sequence", () => {
    const v = makeViewer();

    v.viewer.handleInput("j");
    v.viewer.handleInput("g");
    v.viewer.handleInput("g"); // alpha
    v.viewer.handleInput("j"); // beta
    annotate(v.viewer, "c");

    expect(v.lines[1]!.comment).toBe("c");
  });

  test("escape while pending is dropped; next escape quits", () => {
    const v = makeViewer();

    v.viewer.handleInput("g");
    v.viewer.handleInput("\x1b"); // dropped: pending reset, no quit

    expect(v.doneCalls()).toBe(0);

    v.viewer.handleInput("\x1b"); // root escape → quit (no comments)

    expect(v.doneCalls()).toBe(1);
  });

  test("G and gg are no-ops on a binary file", () => {
    const files: NonEmpty<DiffFile> = [
      textFile("a.ts", [{ header: "@@", lines: [add("alpha", 1)] }]),
      binaryFile("logo.png"),
    ];
    const { tui, renderCount } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.handleInput("n");
    const before = renderCount();

    viewer.handleInput("G");
    expect(renderCount()).toBe(before); // root command: nothing new to draw

    viewer.handleInput("g");
    expect(renderCount()).toBe(before + 1); // pending indicator appears

    viewer.handleInput("g"); // resolves to a no-op jump; only the indicator clears
    expect(renderCount()).toBe(before + 2);
  });
});

describe("pending key indicator", () => {
  test("pending keys render right-aligned on the title row", () => {
    const v = makeViewer();

    v.viewer.handleInput("g");
    const out = v.viewer.render(80);

    expect(out[0]!.endsWith("g")).toBe(true);
    expect(out[0]!.length).toBe(80);
    expect(out[1]).toContain("[1/2] a.ts (modified)"); // rest of the layout unchanged
  });

  test("completing the chord clears the indicator", () => {
    const v = makeViewer();

    v.viewer.handleInput("g");
    v.viewer.handleInput("g"); // resolves: jump to the first line

    const out = v.viewer.render(80);
    expect(out[0]).toContain("walkthrough · unstaged changes · 0 comments");
    expect(out[0]!.endsWith("? for help")).toBe(true);
  });

  test("an unbound key clears the indicator", () => {
    const v = makeViewer();

    v.viewer.handleInput("g");
    v.viewer.handleInput("x"); // dropped, and the indicator goes with it

    const out = v.viewer.render(80);
    expect(out[0]).toContain("walkthrough · unstaged changes · 0 comments");
    expect(out[0]!.endsWith("? for help")).toBe(true);
  });
});

describe("render shape", () => {
  test("renders only the current file's rows", () => {
    const v = makeViewer();

    const out = v.viewer.render(80);

    expect(out[0]).toContain("walkthrough · unstaged changes · 0 comments");
    expect(out[0]!.endsWith("? for help")).toBe(true);
    expect(out[1]).toContain("[1/2] a.ts (modified)");
    expect(out[2]).toBe("@@ -1,2 +1,2 @@");
    expect(out[3]).toContain("alpha");
    expect(out[4]).toContain("beta");
    expect(out.some((line) => line.includes("b.ts"))).toBe(false);
    expect(out.some((line) => line.includes("^f"))).toBe(false);
  });

  test("after n only the next file's rows render", () => {
    const v = makeViewer();

    v.viewer.handleInput("n");
    const out = v.viewer.render(80);

    expect(out[1]).toContain("[2/2] b.ts (modified)");
    expect(out[2]).toBe("@@ -1,2 +1,2 @@");
    expect(out[3]).toContain("gamma");
    expect(out[4]).toContain("delta");
    expect(out.some((line) => line.includes("a.ts"))).toBe(false);
  });

  test("cursor row padded to full width; other rows shorter", () => {
    const v = makeViewer();

    const out = v.viewer.render(80);

    expect(out[3]!.length).toBe(80);
    expect(out[3]).toContain("alpha");
    expect(out[2]!.length).toBeLessThan(80);
  });

  test("header shows the live comment count", () => {
    const v = makeViewer();
    annotate(v.viewer, "c1");

    expect(v.viewer.render(80)[0]).toContain("· 1 comments");
  });

  test("binary file gets its own placeholder screen", () => {
    const files: NonEmpty<DiffFile> = [
      textFile("a.ts", [{ header: "@@", lines: [add("alpha", 1)] }]),
      binaryFile("logo.png"),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    const first = viewer.render(80);
    expect(first[1]).toContain("[1/2] a.ts (modified)");
    expect(first.some((line) => line.includes("logo.png"))).toBe(false);

    viewer.handleInput("n");
    const second = viewer.render(80);
    expect(second[1]).toContain("[2/2] logo.png (modified)");
    expect(second[2]).toContain("binary file — not displayed");
    expect(second.some((line) => line.includes("alpha"))).toBe(false);

    viewer.handleInput("a"); // no cursor rows on a binary screen
    expect(viewer.render(80).some((line) => line.includes("annotate L"))).toBe(
      false,
    );
  });

  test("file header stays pinned after scrolling", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files: NonEmpty<DiffFile> = [
      textFile("big.ts", [{ header: "@@", lines }]),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    for (let i = 0; i < 3; i++) viewer.handleInput("\x04"); // clamp to last line
    const out = viewer.render(80);

    expect(out[1]).toContain("[1/1] big.ts (modified)");
    expect(out.some((line) => line.includes("line0"))).toBe(false);
  });
});

describe("integration with buildPrompt", () => {
  test("comments annotated through the viewer flow into buildPrompt", () => {
    const v = makeViewer();
    annotate(v.viewer, "fix alpha");

    const prompt = buildPrompt(v.files);

    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("fix alpha");
  });
});

describe("help overlay", () => {
  test("? opens the help overlay", () => {
    const v = makeViewer();

    v.viewer.handleInput("?");

    expect(v.overlays.length).toBe(1);
    const overlay = v.overlays[0]!.component as HelpOverlay;
    expect(v.overlays[0]!.options).toEqual({
      anchor: "center",
      width: overlay.width,
      margin: 1,
    });
    const text = overlay.render(200).join("\n");
    expect(text).toContain("j / ↓");
    expect(text).toContain("ctrl+f");
    expect(text).toContain("page down");
    expect(text).toContain("gg");
    expect(text).toContain("G");
    expect(text).toContain("q / esc");
    expect(text).toContain("toggle this help");
    expect(v.viewer.render(80).some((line) => line.includes("^f"))).toBe(false);
  });

  test("the window hugs its content", () => {
    const v = makeViewer();
    v.viewer.handleInput("?");

    const overlay = v.overlays[0]!.component as HelpOverlay;
    for (const row of overlay.render(200)) {
      expect(visibleWidth(row)).toBe(overlay.width);
    }
  });

  test("q, ctrl+c, escape, and ? close the help overlay", () => {
    for (const key of ["q", "\x03", "\x1b", "?"]) {
      const v = makeViewer();
      v.viewer.handleInput("?");

      const overlay = v.overlays[0]!.component as HelpOverlay;
      overlay.handleInput(key);

      expect(v.overlays.length).toBe(0);
      expect(v.doneCalls()).toBe(0);
    }
  });

  test("unhandled keys are ignored while open", () => {
    const v = makeViewer();
    v.viewer.handleInput("?");

    (v.overlays[0]!.component as HelpOverlay).handleInput("x");

    expect(v.overlays.length).toBe(1);
  });

  test("viewer keys work after closing", () => {
    const v = makeViewer();
    v.viewer.handleInput("?");
    (v.overlays[0]!.component as HelpOverlay).handleInput("q");

    expect(v.overlays.length).toBe(0);
    expect(v.lines[0]!.comment).toBeUndefined();

    v.viewer.handleInput("j");
    annotate(v.viewer, "moved");

    expect(v.lines[1]!.comment).toBe("moved");
  });
});
