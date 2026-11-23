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

export class WalkthroughViewer implements Component {
  readonly #files: DiffFile[];
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: null) => void;
  readonly #fileRows: { rows: Row[]; cursorRows: CursorRow[] }[];
  #fileIndex = 0;
  #cursor = 0;
  #scrollOffset = 0;
  #annotating: { input: Input } | null = null;
  #confirmQuit = false;
  #lastViewportRows = 20;

  constructor(
    files: DiffFile[],
    tui: TUI,
    theme: Theme,
    done: (result: null) => void,
  ) {
    this.#files = files;
    this.#tui = tui;
    this.#theme = theme;
    this.#done = done;

    this.#fileRows = files.map((file) => buildRows(file));
  }

  get #current(): { rows: Row[]; cursorRows: CursorRow[] } {
    const screen = this.#fileRows[this.#fileIndex];
    if (screen === undefined) throw new Error("fileIndex out of range");
    return screen;
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
    } else if (matchesKey(data, "pageDown")) {
      this.#moveCursor(this.#lastViewportRows);
    } else if (matchesKey(data, "pageUp")) {
      this.#moveCursor(-this.#lastViewportRows);
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

    const annotating = this.#annotating !== null;
    const viewportRows = Math.max(
      1,
      this.#tui.terminal.rows - 2 - (annotating ? 1 : 0),
    );
    this.#lastViewportRows = viewportRows;

    const { rows: fileRows, cursorRows } = this.#current;

    const cursorEntry = cursorRows[this.#cursor];
    this.#scrollOffset = scrollIntoView(
      this.#scrollOffset,
      cursorEntry?.rowIndex ?? 0,
      viewportRows,
    );

    const { maxOld, maxNew } = gutterWidths(fileRows);

    const end = Math.min(fileRows.length, this.#scrollOffset + viewportRows);
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
              "j/k move · a annotate · p/n file · d done · q quit",
            ),
            width,
          ),
    );
    return rows;
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
    if (row.kind === "fileHeader") {
      const file = row.file;
      const pos = theme.fg(
        "dim",
        `[${this.#fileIndex + 1}/${this.#files.length}] `,
      );
      const status = theme.fg("muted", ` (${file.status})`);
      text = pos + theme.bold(file.path) + status;
    } else if (row.kind === "placeholder") {
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
    const next =
      (this.#fileIndex + direction + this.#files.length) % this.#files.length;
    if (next === this.#fileIndex) return; // single file: nothing to switch
    this.#fileIndex = next;
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
