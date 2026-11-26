import {
  applyBackgroundToLine,
  type Component,
  Input,
  type KeyId,
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
  cursor: number;
  scrollOffset: number;
};

function rotate(entries: NonEmpty<Entry>, direction: 1 | -1): NonEmpty<Entry> {
  const off = direction === 1 ? 1 : entries.length - 1;
  const [head, ...tail] = [...entries.slice(off), ...entries.slice(0, off)];
  if (head === undefined) {
    throw new Error("unreachable: rotation of a non-empty ring");
  }
  return [head, ...tail];
}

type KeyCommand = { kind: "command"; run: () => void };
type KeyPrefix = { kind: "prefix"; children: Keymap };
type KeyBinding = KeyCommand | KeyPrefix;
type Keymap = { [K in KeyId]?: KeyBinding };

function command(run: () => void): KeyBinding {
  return { kind: "command", run };
}
function prefix(children: Keymap): KeyBinding {
  return { kind: "prefix", children };
}

export class WalkthroughViewer implements Component {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: null) => void;
  #entries: NonEmpty<Entry>;
  #annotating: { input: Input } | null = null;
  #confirmQuit = false;
  #lastViewportRows = 20;
  #keymap: Keymap;
  #pendingKeymap: Keymap;

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
      {
        file: first,
        index: 0,
        cursor: 0,
        scrollOffset: 0,
        ...buildRows(first),
      },
      ...rest.map((file, index) => ({
        file,
        index: index + 1,
        cursor: 0,
        scrollOffset: 0,
        ...buildRows(file),
      })),
    ];

    this.#keymap = {
      j: command(() => this.#moveCursor(1)),
      down: command(() => this.#moveCursor(1)),
      k: command(() => this.#moveCursor(-1)),
      up: command(() => this.#moveCursor(-1)),
      n: command(() => this.#switchFile(1)),
      p: command(() => this.#switchFile(-1)),
      "ctrl+f": command(() => this.#moveCursor(this.#lastViewportRows)),
      "ctrl+b": command(() => this.#moveCursor(-this.#lastViewportRows)),
      "ctrl+d": command(() =>
        this.#moveCursor(Math.floor(this.#lastViewportRows / 2)),
      ),
      "ctrl+u": command(() =>
        this.#moveCursor(-Math.floor(this.#lastViewportRows / 2)),
      ),
      a: command(() => this.#startAnnotate()),
      d: command(() => this.#done(null)),
      q: command(() => this.#quit()),
      escape: command(() => this.#quit()),
      g: prefix({ g: command(() => this.#moveCursorTo(0)) }),
      "shift+g": command(() =>
        this.#moveCursorTo(this.#current.cursorRows.length - 1),
      ),
    };
    this.#pendingKeymap = this.#keymap;
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

    const node = this.#lookup(data);
    if (node === undefined) {
      this.#pendingKeymap = this.#keymap; // unknown key: reset and drop
      return;
    }

    if (node.kind === "prefix") {
      this.#pendingKeymap = node.children; // wait for the rest of the sequence
      return;
    }

    this.#pendingKeymap = this.#keymap;
    node.run();
  }

  #lookup(data: string): KeyBinding | undefined {
    for (const [keyId, node] of Object.entries(this.#pendingKeymap)) {
      if (matchesKey(data, keyId as KeyId)) return node;
    }
    return undefined;
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

    const entry = this.#current;
    const { rows: fileRows, cursorRows } = entry;

    const cursorEntry = cursorRows[entry.cursor];
    entry.scrollOffset = scrollIntoView(
      entry.scrollOffset,
      cursorEntry?.rowIndex ?? 0,
      bodyRows,
    );

    const { maxOld, maxNew } = gutterWidths(fileRows);

    const end = Math.min(fileRows.length, entry.scrollOffset + bodyRows);
    const cursorRow = cursorEntry?.row;
    for (const row of fileRows.slice(entry.scrollOffset, end)) {
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
              "j/k move·^f/^b page·^d/^u half·gg/G top/end·a annotate·p/n file·d done·q quit",
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
    const entry = this.#current;
    const next = moveCursor(entry.cursor, delta, entry.cursorRows.length);
    if (next !== entry.cursor) {
      entry.cursor = next;
      this.#tui.requestRender();
    }
  }

  #moveCursorTo(row: number): void {
    this.#moveCursor(row - this.#current.cursor);
  }

  #switchFile(direction: 1 | -1): void {
    if (this.#entries.length === 1) return; // single file: nothing to switch
    this.#entries = rotate(this.#entries, direction);
    this.#tui.requestRender();
  }

  #startAnnotate(): void {
    const entry = this.#current.cursorRows[this.#current.cursor];
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
