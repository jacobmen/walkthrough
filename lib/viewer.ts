import {
  applyBackgroundToLine,
  type Component,
  Input,
  matchesKey,
  singleLine,
  type Theme,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { type DiffFile, diffLineNumber } from "./diff";
import {
  applyComment,
  buildRows,
  type CursorRow,
  clearComments,
  countComments,
  gutterWidths,
  type Row,
  scrollIntoView,
  moveCursor,
} from "./review-model";

export type NonEmpty<T> = [T, ...T[]];

export function nonEmpty<T>(items: T[]): items is NonEmpty<T> {
  return items.length > 0;
}

type Entry = {
  file: DiffFile;
  index: number;
  rows: Row[];
  cursorRows: CursorRow[];
};

function rotate(entries: NonEmpty<Entry>, direction: 1 | -1): NonEmpty<Entry> {
  const off = direction === 1 ? 1 : entries.length - 1;
  const [head, ...tail] = [...entries.slice(off), ...entries.slice(0, off)];
  if (head === undefined) {
    throw new Error("unreachable: rotation of a non-empty ring");
  }
  return [head, ...tail];
}

export class WalkthroughViewer implements Component {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: null) => void;
  #entries: NonEmpty<Entry>;
  #cursor = 0;
  #scrollOffset = 0;
  #annotating: { input: Input } | null = null;
  #confirmQuit = false;
  #lastViewportRows = 20;

  constructor(
    files: NonEmpty<DiffFile>,
    tui: TUI,
    theme: Theme,
    done: (result: null) => void,
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#done = done;
    const [first, ...rest] = files;
    this.#entries = [
      { file: first, index: 0, ...buildRows(first) },
      ...rest.map((file, index) => ({
        file,
        index: index + 1,
        ...buildRows(file),
      })),
    ];
  }

  get #current(): Entry {
    return this.#entries[0];
  }

  get #files(): DiffFile[] {
    return this.#entries.map((entry) => entry.file);
  }

  handleInput(data: string): void {
    if (this.#annotating) {
      this.#annotating.input.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    if (this.#confirmQuit) {
      if (matchesKey(data, "y")) {
        clearComments(this.#files);
        this.#done(null);
      } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
        this.#confirmQuit = false;
        this.#tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.#moveCursor(1);
    } else if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.#moveCursor(-1);
    } else if (matchesKey(data, "n")) {
      this.#switchFile(1);
    } else if (matchesKey(data, "p")) {
      this.#switchFile(-1);
    } else if (matchesKey(data, "ctrl+f")) {
      this.#moveCursor(this.#lastViewportRows);
    } else if (matchesKey(data, "ctrl+b")) {
      this.#moveCursor(-this.#lastViewportRows);
    } else if (matchesKey(data, "ctrl+d")) {
      this.#moveCursor(Math.floor(this.#lastViewportRows / 2));
    } else if (matchesKey(data, "ctrl+u")) {
      this.#moveCursor(-Math.floor(this.#lastViewportRows / 2));
    } else if (matchesKey(data, "a")) {
      this.#startAnnotate();
    } else if (matchesKey(data, "d")) {
      this.#done(null);
    } else if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.#quit();
    }
    // anything else: ignored
  }

  render(width: number): readonly string[] {
    const theme = this.#theme;
    const commentCount = countComments(this.#files);

    const rows: string[] = [];
    rows.push(
      truncateToWidth(
        `${theme.fg("dim", "walkthrough · unstaged changes · ")}${theme.fg("accent", `${commentCount} comments`)}`,
        width,
      ),
    );
    rows.push(this.#renderFileHeader(this.#current, width));

    const annotating = this.#annotating !== null;
    const viewportRows = Math.max(
      1,
      this.#tui.terminal.rows - 2 - (annotating ? 1 : 0),
    );
    // Pinned file header takes one row; Math.max guards tiny terminals.
    const bodyRows = Math.max(1, viewportRows - 1);
    this.#lastViewportRows = bodyRows;

    const { rows: fileRows, cursorRows } = this.#current;

    const cursorEntry = cursorRows[this.#cursor];
    this.#scrollOffset = scrollIntoView(
      this.#scrollOffset,
      cursorEntry?.rowIndex ?? 0,
      bodyRows,
    );

    const { maxOld, maxNew } = gutterWidths(fileRows);

    const end = Math.min(fileRows.length, this.#scrollOffset + bodyRows);
    const cursorRow = cursorEntry?.row;
    for (const row of fileRows.slice(this.#scrollOffset, end)) {
      rows.push(this.#renderRow(row, row === cursorRow, width, maxOld, maxNew));
    }

    // Pad the body so the overlay keeps a stable full-screen height.
    while (rows.length < viewportRows + 1) rows.push("");

    if (this.#annotating) {
      rows.push(this.#annotating.input.render(width)[0] ?? "");
    }

    rows.push(
      this.#confirmQuit
        ? truncateToWidth(
            theme.fg("warning", `Discard ${commentCount} comments? y/n`),
            width,
          )
        : truncateToWidth(
            theme.fg(
              "dim",
              "j/k move · ^f/^b page · ^d/^u half · a annotate · p/n file · d done · q quit",
            ),
            width,
          ),
    );
    return rows;
  }

  #renderFileHeader(entry: Entry, width: number): string {
    const theme = this.#theme;
    const pos = theme.fg(
      "dim",
      `[${entry.index + 1}/${this.#entries.length}] `,
    );
    const status = theme.fg("muted", ` (${entry.file.status})`);
    const text = pos + theme.bold(entry.file.path) + status;
    return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  }

  #renderRow(
    row: Row,
    isCursor: boolean,
    width: number,
    maxOld: number,
    maxNew: number,
  ): string {
    const theme = this.#theme;
    let text: string;
    if (row.kind === "placeholder") {
      text = theme.fg("muted", "binary file — not displayed");
    } else if (row.kind === "hunkHeader") {
      text = theme.fg("dim", row.header);
    } else {
      const line = row.line;
      const oldNo = line.kind === "add" ? "" : String(line.oldLine);
      const newNo = line.kind === "del" ? "" : String(line.newLine);
      const gutter = oldNo.padStart(maxOld) + " " + newNo.padStart(maxNew);
      const marker = line.comment !== undefined ? theme.fg("accent", "●") : " ";
      const prefix =
        line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      const content = singleLine(line.content);
      const colored =
        line.kind === "add"
          ? theme.fg("success", prefix + content)
          : line.kind === "del"
            ? theme.fg("error", prefix + content)
            : prefix + content;
      text = `${gutter} ${marker} ${colored}`;
    }

    // Truncate to width first (ANSI-aware); the cursor fill pads to full width.
    let lineText =
      visibleWidth(text) > width ? truncateToWidth(text, width) : text;
    if (isCursor) {
      // applyBackgroundToLine pads to width and re-opens the background after
      // nested resets; bgFill re-applies it after full/background resets.
      lineText = applyBackgroundToLine(lineText, width, (t) =>
        theme.bgFill("selectedBg", t),
      );
    }
    return lineText;
  }

  #moveCursor(delta: number): void {
    const next = moveCursor(
      this.#cursor,
      delta,
      this.#current.cursorRows.length,
    );
    if (next !== this.#cursor) {
      this.#cursor = next;
      this.#tui.requestRender();
    }
  }

  #switchFile(direction: 1 | -1): void {
    if (this.#entries.length === 1) return; // single file: nothing to switch
    this.#entries = rotate(this.#entries, direction);
    this.#cursor = 0;
    this.#scrollOffset = 0;
    this.#tui.requestRender();
  }

  #startAnnotate(): void {
    const entry = this.#current.cursorRows[this.#cursor];
    if (entry === undefined) return;
    const line = entry.row.line;

    const input = new Input();
    input.prompt = `annotate L${diffLineNumber(line)}: `;
    input.setValue(line.comment ?? "");
    input.onSubmit = (value: string) => {
      applyComment(line, value);
      this.#annotating = null;
      this.#tui.requestRender();
    };
    input.onEscape = () => {
      this.#annotating = null;
      this.#tui.requestRender();
    };

    this.#annotating = { input };
    this.#tui.requestRender();
  }

  #quit(): void {
    if (countComments(this.#files) > 0) {
      this.#confirmQuit = true;
      this.#tui.requestRender();
    } else {
      this.#done(null);
    }
  }
}
