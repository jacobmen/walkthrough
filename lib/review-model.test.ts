import { describe, expect, test } from "bun:test";
import {
  applyComment,
  buildRows,
  clearComments,
  countComments,
  gutterWidths,
  moveCursor,
  scrollIntoView,
} from "./review-model";
import { add, binaryFile, ctx, del, textFile } from "./test-fixtures";

describe("buildRows", () => {
  test("text file with two hunks → header, hunk headers, lines in order", () => {
    const l1 = ctx("a", 1, 1);
    const l2 = add("b", 2);
    const l3 = del("c", 3);
    const file = textFile("f.ts", [
      { header: "@@ -1,1 +1,1 @@", lines: [l1] },
      { header: "@@ -3,1 +3,1 @@", lines: [l2, l3] },
    ]);

    const { rows, cursorRows } = buildRows(file);

    expect(rows).toEqual([
      { kind: "fileHeader", file },
      { kind: "hunkHeader", header: "@@ -1,1 +1,1 @@" },
      { kind: "diffLine", file, line: l1 },
      { kind: "hunkHeader", header: "@@ -3,1 +3,1 @@" },
      { kind: "diffLine", file, line: l2 },
      { kind: "diffLine", file, line: l3 },
    ]);
    expect(cursorRows).toEqual([
      { rowIndex: 2, row: { kind: "diffLine", file, line: l1 } },
      { rowIndex: 4, row: { kind: "diffLine", file, line: l2 } },
      { rowIndex: 5, row: { kind: "diffLine", file, line: l3 } },
    ]);
  });

  test("binary file → header + placeholder, no cursor rows", () => {
    const file = binaryFile("img.png");
    const { rows, cursorRows } = buildRows(file);

    expect(rows).toEqual([
      { kind: "fileHeader", file },
      { kind: "placeholder" },
    ]);
    expect(cursorRows).toEqual([]);
  });

  test("per-file rows keep the file reference", () => {
    const l1 = add("x", 1);
    const binary = binaryFile("img.png");
    const text = textFile("f.ts", [{ header: "@@", lines: [l1] }]);

    const binaryOut = buildRows(binary);
    expect(binaryOut.rows).toEqual([
      { kind: "fileHeader", file: binary },
      { kind: "placeholder" },
    ]);
    expect(binaryOut.cursorRows).toEqual([]);

    const textOut = buildRows(text);
    expect(textOut.rows).toEqual([
      { kind: "fileHeader", file: text },
      { kind: "hunkHeader", header: "@@" },
      { kind: "diffLine", file: text, line: l1 },
    ]);
    expect(textOut.cursorRows).toEqual([
      { rowIndex: 2, row: { kind: "diffLine", file: text, line: l1 } },
    ]);
  });
});

describe("moveCursor", () => {
  test("steps by delta", () => {
    expect(moveCursor(2, 1, 5)).toBe(3);
    expect(moveCursor(2, -1, 5)).toBe(1);
  });

  test("clamps at both ends", () => {
    expect(moveCursor(0, -1, 5)).toBe(0);
    expect(moveCursor(4, 1, 5)).toBe(4);
    expect(moveCursor(2, 100, 5)).toBe(4);
    expect(moveCursor(2, -100, 5)).toBe(0);
  });

  test("no cursor rows → cursor unchanged for any delta", () => {
    expect(moveCursor(0, 5, 0)).toBe(0);
    expect(moveCursor(3, -7, 0)).toBe(3);
  });
});

describe("gutterWidths", () => {
  test("max old/new widths across line kinds", () => {
    const { rows } = buildRows(
      textFile("f.ts", [
        {
          header: "@@",
          lines: [ctx("a", 9, 10), add("b", 105), del("c", 100)],
        },
      ]),
    );

    expect(gutterWidths(rows)).toEqual({ maxOld: 3, maxNew: 3 });
  });

  test("add-only lines leave maxOld at 0", () => {
    const { rows } = buildRows(
      textFile("f.ts", [{ header: "@@", lines: [add("x", 5)] }]),
    );

    expect(gutterWidths(rows)).toEqual({ maxOld: 0, maxNew: 1 });
  });

  test("del-only lines leave maxNew at 0", () => {
    const { rows } = buildRows(
      textFile("f.ts", [{ header: "@@", lines: [del("x", 12)] }]),
    );

    expect(gutterWidths(rows)).toEqual({ maxOld: 2, maxNew: 0 });
  });

  test("empty rows → zero widths", () => {
    expect(gutterWidths([])).toEqual({ maxOld: 0, maxNew: 0 });
  });
});

describe("countComments", () => {
  test("0 on commentless files including binary", () => {
    const files = [
      textFile("a.ts", [{ header: "@@", lines: [add("x", 1)] }]),
      binaryFile("b.png"),
    ];

    expect(countComments(files)).toBe(0);
  });

  test("counts across files and hunks", () => {
    const l1 = add("x", 1);
    const l2 = del("y", 2);
    const l3 = ctx("z", 3, 3);
    applyComment(l1, "one");
    applyComment(l2, "two");

    const files = [
      textFile("a.ts", [{ header: "@@", lines: [l1] }]),
      textFile("b.ts", [
        { header: "@@", lines: [l3] },
        { header: "@@", lines: [l2] },
      ]),
      binaryFile("b.png"),
    ];

    expect(countComments(files)).toBe(2);
  });
});

describe("applyComment", () => {
  test("stores the trimmed comment", () => {
    const line = ctx("x", 1, 1);
    applyComment(line, "  hi  ");

    expect(line.comment).toBe("hi");
  });

  test("blank entry deletes an existing comment", () => {
    const line = add("x", 1);
    applyComment(line, "keep");

    expect(line.comment).toBe("keep");

    applyComment(line, "   ");

    expect(line.comment).toBeUndefined();
    expect("comment" in line).toBe(false);
  });

  test("works for every line kind", () => {
    const lines = [add("a", 1), del("b", 2), ctx("c", 3, 3)];

    for (const line of lines) {
      applyComment(line, "note");
      expect(line.comment).toBe("note");
    }
  });
});

describe("clearComments", () => {
  test("removes every comment, leaves content and numbers untouched", () => {
    const l1 = add("a", 1);
    const l2 = ctx("b", 2, 2);
    const l3 = del("c", 3);
    applyComment(l1, "one");
    applyComment(l2, "two");
    applyComment(l3, "three");

    const files = [
      textFile("a.ts", [
        { header: "@@", lines: [l1] },
        { header: "@@", lines: [l2] },
      ]),
      binaryFile("b.png"),
      textFile("c.ts", [{ header: "@@", lines: [l3] }]),
    ];

    clearComments(files);

    expect(countComments(files)).toBe(0);
    expect(l1.content).toBe("a");
    expect(l1.newLine).toBe(1);
    expect(l2.content).toBe("b");
    expect(l3.content).toBe("c");
    expect(l3.oldLine).toBe(3);
  });
});

describe("scrollIntoView", () => {
  test("cursor above the window snaps offset to it", () => {
    expect(scrollIntoView(5, 2, 10)).toBe(2);
  });

  test("cursor inside the window leaves offset unchanged", () => {
    expect(scrollIntoView(3, 7, 10)).toBe(3);
    expect(scrollIntoView(5, 14, 10)).toBe(5); // last row of the window
  });

  test("cursor below the window scrolls to put it on the last row", () => {
    expect(scrollIntoView(5, 15, 10)).toBe(6);
    expect(scrollIntoView(0, 25, 10)).toBe(16);
  });

  test("negative result clamps to 0", () => {
    expect(scrollIntoView(-3, -7, 10)).toBe(0);
  });
});
