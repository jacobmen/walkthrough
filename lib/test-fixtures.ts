import type { Theme, ThemeBg, ThemeColor, TUI } from "@oh-my-pi/pi-tui";
import { type DiffFile, type DiffLine } from "./diff";

type ContextLine = Extract<DiffLine, { kind: "context" }>;
type AddLine = Extract<DiffLine, { kind: "add" }>;
type DelLine = Extract<DiffLine, { kind: "del" }>;

export function ctx(
  content: string,
  oldLine: number,
  newLine: number,
): ContextLine {
  return { kind: "context", content, oldLine, newLine };
}

export function add(content: string, newLine: number): AddLine {
  return { kind: "add", content, newLine };
}

export function del(content: string, oldLine: number): DelLine {
  return { kind: "del", content, oldLine };
}

export function textFile(
  path: string,
  hunks: { header: string; lines: DiffLine[] }[],
): DiffFile {
  return { kind: "text", path, status: "modified", hunks };
}

export function binaryFile(path: string): DiffFile {
  return { kind: "binary", path, status: "modified" };
}

/** Identity fake: every style call returns its input, so rendered text is plain. */
export function identityTheme(): Theme {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bold: (text: string) => text,
    bgFill: (_color: ThemeBg, text: string) => text,
  } as unknown as Theme;
}

/** Headless TUI fake: counts requestRender calls, exposes a fixed row count. */
export function fakeTui(rows: number): { tui: TUI; renderCount(): number } {
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    terminal: { rows },
  } as unknown as TUI;
  return { tui, renderCount: () => renders };
}
