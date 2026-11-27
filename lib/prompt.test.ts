import { describe, expect, test } from "bun:test";

import { buildPrompt } from "./prompt";
import { add, binaryFile, ctx, del, textFile } from "./test-fixtures";

describe("buildPrompt", () => {
  test("no files → empty string", () => {
    expect(buildPrompt([])).toBe("");
  });

  test("files without comments → empty string", () => {
    const files = [
      textFile("a.ts", [{ header: "@@", lines: [ctx("x", 1, 1)] }]),
      binaryFile("logo.png"),
    ];

    expect(buildPrompt(files)).toBe("");
  });

  test("commented add line reports file, line number, snapshot, and comment; binary file skipped", () => {
    const line = add("console.log(1)", 3);
    line.comment = "fix this";
    const files = [
      textFile("diff.ts", [{ header: "@@", lines: [line] }]),
      binaryFile("logo.png"),
    ];

    const out = buildPrompt(files);

    expect(out).toContain("diff.ts");
    expect(out).toContain("Line 3");
    expect(out).toContain("+console.log(1)");
    expect(out).toContain("Comment: fix this");
    expect(out).not.toContain("logo.png");
  });

  test("commented del line is marked removed with a minus snapshot", () => {
    const line = del("old text", 2);
    line.comment = "bring back";

    const out = buildPrompt([
      textFile("a.ts", [{ header: "@@", lines: [line] }]),
    ]);

    expect(out).toContain("Line 2 (removed)");
    expect(out).toContain("-old text");
  });

  test("commented context line has no snapshot prefix", () => {
    const line = ctx("kept", 1, 1);
    line.comment = "note";

    const out = buildPrompt([
      textFile("a.ts", [{ header: "@@", lines: [line] }]),
    ]);

    expect(out).toContain("Line 1: kept");
  });

  test("comments are trimmed", () => {
    const line = add("x", 1);
    line.comment = "  padded  ";

    const out = buildPrompt([
      textFile("a.ts", [{ header: "@@", lines: [line] }]),
    ]);

    expect(out).toContain("Comment: padded");
  });

  test("whitespace-only comments drop the line", () => {
    const line = add("x", 1);
    line.comment = "   ";

    expect(
      buildPrompt([textFile("a.ts", [{ header: "@@", lines: [line] }])]),
    ).toBe("");
  });

  test("comments from multiple files are grouped per file", () => {
    const l1 = add("a", 1);
    const l2 = add("b", 2);
    l1.comment = "c1";
    l2.comment = "c2";

    const out = buildPrompt([
      textFile("one.ts", [{ header: "@@", lines: [l1] }]),
      textFile("two.ts", [{ header: "@@", lines: [l2] }]),
    ]);

    expect(out).toContain("one.ts");
    expect(out).toContain("two.ts");
    expect(out).toContain("c1");
    expect(out).toContain("c2");
  });
});
