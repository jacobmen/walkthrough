import {
  applyBackgroundToLine,
  type Component,
  Input,
  type KeyId,
  matchesKey,
  type OverlayHandle,
  singleLine,
  type Theme,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@oh-my-pi/pi-tui";

import { type DiffFile, diffLineNumber } from "./diff";
import { type HelpEntry, HelpOverlay } from "./help-overlay";
import { command, type Keymap, KeyTrie, prefix } from "./keymap";
import {
  applyComment,
  buildRows,
  clearComments,
  countComments,
  type CursorRow,
  gutterWidths,
  moveCursor,
  type Row,
  scrollIntoView,
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

type BindingSpec =
  | { key: KeyId; label: string; description: string; run: () => void }
  | { key: KeyId; label: string; description: string; children: Keymap };

function helpEntries(bindings: readonly BindingSpec[]): HelpEntry[] {
  const entries: HelpEntry[] = [];
  for (const binding of bindings) {
    const last = entries.at(-1);
    if (last?.label === binding.label) continue;
    entries.push({ label: binding.label, description: binding.description });
  }
  return entries;
}

export class WalkthroughViewer implements Component {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: null) => void;
  #entries: NonEmpty<Entry>;
  #annotating: { input: Input } | null = null;
  #confirmQuit = false;
  #lastViewportRows = 20;
  readonly #bindings: BindingSpec[];
  readonly #keys: KeyTrie;
  #helpHandle: OverlayHandle | null = null;

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

    this.#bindings = [
      {
        key: "j",
        label: "j / ↓",
        description: "move cursor down",
        run: () => this.#moveCursor(1),
      },
      {
        key: "down",
        label: "j / ↓",
        description: "move cursor down",
        run: () => this.#moveCursor(1),
      },
      {
        key: "k",
        label: "k / ↑",
        description: "move cursor up",
        run: () => this.#moveCursor(-1),
      },
      {
        key: "up",
        label: "k / ↑",
        description: "move cursor up",
        run: () => this.#moveCursor(-1),
      },
      {
        key: "ctrl+f",
        label: "ctrl+f",
        description: "page down",
        run: () => this.#moveCursor(this.#lastViewportRows),
      },
      {
        key: "ctrl+b",
        label: "ctrl+b",
        description: "page up",
        run: () => this.#moveCursor(-this.#lastViewportRows),
      },
      {
        key: "ctrl+d",
        label: "ctrl+d",
        description: "half page down",
        run: () => this.#moveCursor(Math.floor(this.#lastViewportRows / 2)),
      },
      {
        key: "ctrl+u",
        label: "ctrl+u",
        description: "half page up",
        run: () => this.#moveCursor(-Math.floor(this.#lastViewportRows / 2)),
      },
      {
        key: "g",
        label: "gg",
        description: "jump to first line",
        children: { g: command(() => this.#moveCursorTo(0)) },
      },
      {
        key: "shift+g",
        label: "G",
        description: "jump to last line",
        run: () => this.#moveCursorTo(this.#current.cursorRows.length - 1),
      },
      {
        key: "n",
        label: "n",
        description: "next file",
        run: () => this.#switchFile(1),
      },
      {
        key: "p",
        label: "p",
        description: "previous file",
        run: () => this.#switchFile(-1),
      },
      {
        key: "a",
        label: "a",
        description: "annotate the cursor line",
        run: () => this.#startAnnotate(),
      },
      {
        key: "d",
        label: "d",
        description: "finish and collect comments",
        run: () => this.#done(null),
      },
      {
        key: "q",
        label: "q / esc",
        description: "quit (asks when comments exist)",
        run: () => this.#quit(),
      },
      {
        key: "escape",
        label: "q / esc",
        description: "quit (asks when comments exist)",
        run: () => this.#quit(),
      },
      {
        key: "?",
        label: "?",
        description: "toggle this help",
        run: () => this.#openHelp(),
      },
    ];
    const keymap: Keymap = {};
    for (const spec of this.#bindings) {
      keymap[spec.key] =
        "children" in spec ? prefix(spec.children) : command(spec.run);
    }
    this.#keys = new KeyTrie(keymap, () => this.#tui.requestRender());
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

    this.#keys.handleInput(data);
  }

  render(width: number): readonly string[] {
    const commentCount = countComments(this.#files);

    const rows: string[] = [];
    rows.push(this.#renderTitle(commentCount, width));
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
    while (rows.length < this.#tui.terminal.rows - (annotating ? 1 : 0)) {
      rows.push("");
    }

    if (this.#annotating) {
      rows.push(this.#annotating.input.render(width)[0] ?? "");
    }

    return rows;
  }

  #renderTitle(commentCount: number, width: number): string {
    const theme = this.#theme;
    const title = `${theme.fg("dim", "walkthrough · unstaged changes · ")}${theme.fg("accent", `${commentCount} comments`)}`;

    const right = this.#confirmQuit
      ? theme.fg("warning", `Discard ${commentCount} comments? y/n`)
      : this.#keys.pending !== ""
        ? theme.fg("accent", theme.bold(this.#keys.pending))
        : theme.fg("dim", "? for help");

    const body = truncateToWidth(
      title,
      Math.max(0, width - visibleWidth(right)),
    );
    const gap = " ".repeat(
      Math.max(0, width - visibleWidth(body) - visibleWidth(right)),
    );
    return body + gap + right;
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

  #openHelp(): void {
    if (this.#helpHandle !== null) return;
    const overlay = new HelpOverlay(
      this.#theme,
      helpEntries(this.#bindings),
      () => this.#closeHelp(),
    );
    this.#helpHandle = this.#tui.showOverlay(overlay, {
      anchor: "center",
      width: overlay.width,
      margin: 1,
    });
  }

  #closeHelp(): void {
    this.#helpHandle?.hide();
    this.#helpHandle = null;
  }
}
