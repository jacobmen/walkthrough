import { describe, expect, test } from "bun:test";
import { buildPrompt } from "./prompt";
import { countComments } from "./review-model";
import {
  add,
  binaryFile,
  fakeTui,
  identityTheme,
  textFile,
} from "./test-fixtures";
import { WalkthroughViewer } from "./viewer";

/** Two text files of two `add` lines each. Cursor rows: alpha, beta, gamma, delta. */
function makeViewer() {
  const lines = [
    add("alpha", 1),
    add("beta", 2),
    add("gamma", 1),
    add("delta", 2),
  ];
  const files = [
    textFile("a.ts", [{ header: "@@ -1,2 +1,2 @@", lines: lines.slice(0, 2) }]),
    textFile("b.ts", [{ header: "@@ -1,2 +1,2 @@", lines: lines.slice(2) }]),
  ];

  const { tui, renderCount } = fakeTui(40);
  let doneCalls = 0;

  const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {
    doneCalls++;
  });

  return { viewer, files, lines, renderCount, doneCalls: () => doneCalls };
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

    expect(v.lines[1].comment).toBe("c1");
    expect(v.lines[0].comment).toBeUndefined();
  });

  test("down arrow moves down", () => {
    const v = makeViewer();

    v.viewer.handleInput("\x1b[B");
    annotate(v.viewer, "c1");

    expect(v.lines[1].comment).toBe("c1");
  });

  test("k moves back up; up arrow stays at the top", () => {
    const v = makeViewer();

    v.viewer.handleInput("j");
    v.viewer.handleInput("k");
    annotate(v.viewer, "top");

    expect(v.lines[0].comment).toBe("top");

    const w = makeViewer();

    w.viewer.handleInput("\x1b[A");
    annotate(w.viewer, "top");

    expect(w.lines[0].comment).toBe("top");
  });

  test("j clamps at the last line", () => {
    const v = makeViewer();

    for (let i = 0; i < 10; i++) v.viewer.handleInput("j");
    annotate(v.viewer, "last");

    expect(v.lines[3].comment).toBe("last");
    expect(v.lines[2].comment).toBeUndefined();
  });

  test("annotate prompt shows the target line number", () => {
    const v = makeViewer();

    v.viewer.handleInput("j"); // beta → L2
    v.viewer.handleInput("a");

    expect(v.viewer.render(80).at(-2)).toContain("annotate L2:");
  });
});

describe("file jump", () => {
  test("n jumps to the first line of the next file, p back", () => {
    const v = makeViewer();

    v.viewer.handleInput("n");
    annotate(v.viewer, "c2");

    expect(v.lines[2].comment).toBe("c2");

    v.viewer.handleInput("p");
    annotate(v.viewer, "c1");

    expect(v.lines[0].comment).toBe("c1");
    expect(v.lines[2].comment).toBe("c2");
  });
});

describe("page keys", () => {
  test("pageDown advances one viewport (render(80) sets 38 rows), with a render request", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files = [textFile("big.ts", [{ header: "@@", lines }])];
    const { tui, renderCount } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80); // viewportRows = 40 - 2 = 38
    const before = renderCount();
    viewer.handleInput("\x1b[6~"); // pageDown: +38 rows

    expect(renderCount()).toBe(before + 1);

    annotate(viewer, "pd");

    expect(lines[38].comment).toBe("pd");
    expect(lines[38].newLine).toBe(39);
  });

  test("pageUp goes back one viewport", () => {
    const lines = Array.from({ length: 50 }, (_, i) => add(`line${i}`, i + 1));
    const files = [textFile("big.ts", [{ header: "@@", lines }])];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    viewer.render(80);
    viewer.handleInput("\x1b[6~");
    viewer.handleInput("\x1b[5~"); // pageUp: -38 rows

    annotate(viewer, "pu");

    expect(lines[0].comment).toBe("pu");
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

    expect(v.lines[0].comment).toBeUndefined();
    expect(v.renderCount()).toBeGreaterThan(before);

    // Prompt closed: j moves the cursor again instead of typing into the input.
    v.viewer.handleInput("j");
    annotate(v.viewer, "c2");

    expect(v.lines[1].comment).toBe("c2");
  });

  test("annotating a commented line prefills; untouched submit keeps the comment", () => {
    const v = makeViewer();
    annotate(v.viewer, "keep me");

    v.viewer.handleInput("a"); // input prefilled with "keep me"
    v.viewer.handleInput("\r"); // submit untouched

    expect(v.lines[0].comment).toBe("keep me");
  });

  test("submitting an emptied value deletes an existing comment", () => {
    const v = makeViewer();
    annotate(v.viewer, "keep me");

    v.viewer.handleInput("a");
    for (let i = 0; i < 10; i++) v.viewer.handleInput("\x7f"); // backspace
    v.viewer.handleInput("\r");

    expect(v.lines[0].comment).toBeUndefined();
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
    expect(v.viewer.render(80).at(-1)).toContain("Discard 1 comments? y/n");

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
    expect(v.viewer.render(80).at(-1)).toContain("d done");
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
    expect(v.lines[0].comment).toBe("c1");
  });
});

describe("render shape", () => {
  test("header, file headers, hunk header, and footer with identity theme", () => {
    const v = makeViewer();

    const out = v.viewer.render(80);

    expect(out[0]).toBe("walkthrough · unstaged changes · 0 comments");
    expect(out[1]).toContain("[1/2] a.ts (modified)");
    expect(out[2]).toBe("@@ -1,2 +1,2 @@");
    expect(out[3]).toContain("alpha");
    expect(out[4]).toContain("beta");
    expect(out[5]).toContain("[2/2] b.ts (modified)");
    expect(out.at(-1)).toBe(
      "j/k move · a annotate · p/n file · d done · q quit",
    );
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

  test("binary file renders header and placeholder rows", () => {
    const files = [
      textFile("a.ts", [{ header: "@@", lines: [add("alpha", 1)] }]),
      binaryFile("logo.png"),
    ];
    const { tui } = fakeTui(40);
    const viewer = new WalkthroughViewer(files, tui, identityTheme(), () => {});

    const out = viewer.render(80);

    expect(out[1]).toContain("[1/2] a.ts (modified)");
    expect(out[4]).toContain("[2/2] logo.png (modified)");
    expect(out[5]).toContain("binary file — not displayed");
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
