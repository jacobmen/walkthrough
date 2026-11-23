import type { DiffFile, DiffLine } from "./diff";

export type Row =
  | { kind: "fileHeader"; file: DiffFile }
  | { kind: "placeholder" }
  | { kind: "hunkHeader"; header: string }
  | { kind: "diffLine"; file: DiffFile; line: DiffLine };

/** Cursor-navigable row: its position in `rows` plus the diffLine row itself. */
export type CursorRow = {
  rowIndex: number;
  row: Extract<Row, { kind: "diffLine" }>;
};

export function buildRows(files: DiffFile[]): {
  rows: Row[];
  cursorRows: CursorRow[];
} {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ kind: "fileHeader", file });
    if (file.kind === "binary") {
      rows.push({ kind: "placeholder" });
      continue;
    }
    for (const hunk of file.hunks) {
      rows.push({ kind: "hunkHeader", header: hunk.header });
      for (const line of hunk.lines) {
        rows.push({ kind: "diffLine", file, line });
      }
    }
  }

  const cursorRows: CursorRow[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.kind === "diffLine") cursorRows.push({ rowIndex, row });
  }
  return { rows, cursorRows };
}

export function moveCursor(
  cursor: number,
  delta: number,
  cursorRowCount: number,
): number {
  if (cursorRowCount === 0) return cursor;
  return Math.min(Math.max(cursor + delta, 0), cursorRowCount - 1);
}

export function jumpFile(
  cursorRows: CursorRow[],
  cursor: number,
  direction: 1 | -1,
  files: DiffFile[],
): number {
  if (cursorRows.length === 0) return cursor;
  const entry = cursorRows[cursor];
  if (entry === undefined) return cursor;

  const start = files.indexOf(entry.row.file);
  if (start === -1) return cursor;

  // Probe files in direction order, wrapping through the cursor's own file last.
  let bestCursor: number | undefined;
  let bestOrder = Infinity;
  for (const [fi, file] of files.entries()) {
    const first = cursorRows.findIndex((e) => e.row.file === file);
    if (first < 0) continue;
    const dist =
      direction === 1
        ? (fi - start + files.length) % files.length
        : (start - fi + files.length) % files.length;
    const order = dist === 0 ? files.length : dist;
    if (order < bestOrder) {
      bestOrder = order;
      bestCursor = first;
    }
  }
  return bestCursor ?? cursor;
}

export function gutterWidths(rows: Row[]): { maxOld: number; maxNew: number } {
  let maxOld = 0;
  let maxNew = 0;
  for (const row of rows) {
    if (row.kind !== "diffLine") continue;
    const line = row.line;
    if (line.kind === "context") {
      maxOld = Math.max(maxOld, String(line.oldLine).length);
      maxNew = Math.max(maxNew, String(line.newLine).length);
    } else if (line.kind === "add") {
      maxNew = Math.max(maxNew, String(line.newLine).length);
    } else {
      maxOld = Math.max(maxOld, String(line.oldLine).length);
    }
  }
  return { maxOld, maxNew };
}

export function countComments(files: DiffFile[]): number {
  let count = 0;
  for (const file of files) {
    if (file.kind !== "text") continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.comment !== undefined) count++;
      }
    }
  }
  return count;
}

export function applyComment(line: DiffLine, raw: string): void {
  const trimmed = raw.trim();
  if (trimmed) {
    line.comment = trimmed;
  } else {
    delete line.comment;
  }
}

export function clearComments(files: DiffFile[]): void {
  for (const file of files) {
    if (file.kind !== "text") continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) delete line.comment;
    }
  }
}

export function scrollIntoView(
  offset: number,
  cursorRowIndex: number,
  viewportRows: number,
): number {
  let next = offset;
  if (cursorRowIndex < next) {
    next = cursorRowIndex;
  } else if (cursorRowIndex >= next + viewportRows) {
    next = cursorRowIndex - viewportRows + 1;
  }
  return Math.max(0, next);
}
