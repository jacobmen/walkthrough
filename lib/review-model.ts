import type { DiffFile, DiffLine } from "./diff";

export type Row =
  | { kind: "fileHeader"; fileIndex: number }
  | { kind: "placeholder"; fileIndex: number }
  | { kind: "hunkHeader"; fileIndex: number; header: string }
  | { kind: "diffLine"; fileIndex: number; line: DiffLine };

export function buildRows(files: DiffFile[]): {
  rows: Row[];
  cursorRows: number[];
} {
  const rows: Row[] = [];
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi]!;
    rows.push({ kind: "fileHeader", fileIndex: fi });
    if (file.kind === "binary") {
      rows.push({ kind: "placeholder", fileIndex: fi });
      continue;
    }
    for (const hunk of file.hunks) {
      rows.push({ kind: "hunkHeader", fileIndex: fi, header: hunk.header });
      for (const line of hunk.lines) {
        rows.push({ kind: "diffLine", fileIndex: fi, line });
      }
    }
  }

  const cursorRows: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === "diffLine") cursorRows.push(i);
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
  rows: Row[],
  cursorRows: number[],
  cursor: number,
  direction: 1 | -1,
): number {
  if (cursorRows.length === 0) return cursor;
  const row = rows[cursorRows[cursor]!];
  if (!row || row.kind !== "diffLine") return cursor;

  let lastFile = 0;
  for (const r of rows) {
    if (r.fileIndex > lastFile) lastFile = r.fileIndex;
  }

  let target = row.fileIndex + direction;
  while (target >= 0 && target <= lastFile) {
    const idx = cursorRows.findIndex((i) => {
      const r = rows[i]!;
      return r.kind === "diffLine" && r.fileIndex === target;
    });
    if (idx >= 0) return idx;
    target += direction; // skip files without diff lines
  }
  return cursor;
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
