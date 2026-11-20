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
import { type DiffFile, type DiffLine, diffLineNumber } from "./diff";

type Row =
  | { kind: "fileHeader"; fileIndex: number }
  | { kind: "placeholder"; fileIndex: number }
  | { kind: "hunkHeader"; fileIndex: number; header: string }
  | { kind: "diffLine"; fileIndex: number; line: DiffLine };

/**
 * Full-screen overlay reviewing the unstaged diff: j/k to move, `a` to annotate
 * the cursor line, p/n to jump between files, `d` to finish (comments are read
 * off the DiffFile objects by the caller), q/Esc to quit.
 */
export class WalkthroughViewer implements Component {
  readonly #files: DiffFile[];
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: null) => void;
  readonly #rows: Row[] = [];
  readonly #cursorRows: number[] = [];
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

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]!;
      this.#rows.push({ kind: "fileHeader", fileIndex: fi });
      if (file.kind === "binary") {
        this.#rows.push({ kind: "placeholder", fileIndex: fi });
        continue;
      }
      for (const hunk of file.hunks) {
        this.#rows.push({
          kind: "hunkHeader",
          fileIndex: fi,
          header: hunk.header,
        });
        for (const line of hunk.lines) {
          this.#rows.push({ kind: "diffLine", fileIndex: fi, line });
        }
      }
    }
    for (let i = 0; i < this.#rows.length; i++) {
      if (this.#rows[i]!.kind === "diffLine") this.#cursorRows.push(i);
    }
  }

  handleInput(data: string): void {
    if (this.#annotating) {
      this.#annotating.input.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    if (this.#confirmQuit) {
      if (matchesKey(data, "y")) {
        // "Discard" means discard: drop every comment so the caller's
        // buildPrompt finds none and leaves the composer untouched.
        for (const file of this.#files) {
          if (file.kind !== "text") continue;
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) delete line.comment;
          }
        }
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
      this.#jumpFile(1);
    } else if (matchesKey(data, "p")) {
      this.#jumpFile(-1);
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
    const commentCount = this.#countComments();

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

    // Scroll so the cursor row is visible.
    const cursorRowIndex = this.#cursorRows[this.#cursor] ?? 0;
    if (cursorRowIndex < this.#scrollOffset) {
      this.#scrollOffset = cursorRowIndex;
    } else if (cursorRowIndex >= this.#scrollOffset + viewportRows) {
      this.#scrollOffset = cursorRowIndex - viewportRows + 1;
    }
    this.#scrollOffset = Math.max(0, this.#scrollOffset);

    const { maxOld, maxNew } = this.#gutterWidths();

    const end = Math.min(this.#rows.length, this.#scrollOffset + viewportRows);
    for (let i = this.#scrollOffset; i < end; i++) {
      rows.push(
        this.#renderRow(
          this.#rows[i]!,
          i === cursorRowIndex,
          width,
          maxOld,
          maxNew,
        ),
      );
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
      const file = this.#files[row.fileIndex]!;
      const pos = theme.fg(
        "dim",
        `[${row.fileIndex + 1}/${this.#files.length}] `,
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

  #gutterWidths(): { maxOld: number; maxNew: number } {
    let maxOld = 0;
    let maxNew = 0;
    for (const row of this.#rows) {
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

  #countComments(): number {
    let count = 0;
    for (const file of this.#files) {
      if (file.kind !== "text") continue;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.comment !== undefined) count++;
        }
      }
    }
    return count;
  }

  #moveCursor(delta: number): void {
    if (this.#cursorRows.length === 0) return;
    const next = Math.min(
      Math.max(this.#cursor + delta, 0),
      this.#cursorRows.length - 1,
    );
    if (next !== this.#cursor) {
      this.#cursor = next;
      this.#tui.requestRender();
    }
  }

  #jumpFile(direction: 1 | -1): void {
    if (this.#cursorRows.length === 0) return;
    const row = this.#rows[this.#cursorRows[this.#cursor]!];
    if (!row || row.kind !== "diffLine") return;
    let target = row.fileIndex + direction;
    while (target >= 0 && target < this.#files.length) {
      const idx = this.#cursorRows.findIndex((i) => {
        const r = this.#rows[i]!;
        return r.kind === "diffLine" && r.fileIndex === target;
      });
      if (idx >= 0) {
        this.#cursor = idx;
        this.#tui.requestRender();
        return;
      }
      target += direction; // skip binary-only files
    }
  }

  #startAnnotate(): void {
    const row = this.#rows[this.#cursorRows[this.#cursor]!];
    if (!row || row.kind !== "diffLine") return;
    const line = row.line;
    const input = new Input();
    input.prompt = `annotate L${diffLineNumber(line)}: `;
    input.setValue(line.comment ?? "");
    input.onSubmit = (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        line.comment = trimmed;
      } else {
        delete line.comment;
      }
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
    if (this.#countComments() > 0) {
      this.#confirmQuit = true;
      this.#tui.requestRender();
    } else {
      this.#done(null);
    }
  }
}
