import type {
  Component,
  OverlayOptions,
  Theme,
  ThemeBg,
  ThemeColor,
  TUI,
} from "@oh-my-pi/pi-tui";
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
    bg: (_color: ThemeBg, text: string) => text,
    bgFill: (_color: ThemeBg, text: string) => text,
  } as unknown as Theme;
}

/** Headless TUI fake: counts requestRender calls, exposes a fixed row count. */
export function fakeTui(rows: number): {
  tui: TUI;
  renderCount(): number;
  overlays: { component: Component; options?: OverlayOptions }[];
} {
  let renders = 0;
  const overlays: { component: Component; options?: OverlayOptions }[] = [];
  const tui = {
    requestRender: () => {
      renders++;
    },
    terminal: { rows },
    showOverlay: (component: Component, options?: OverlayOptions) => {
      const entry: { component: Component; options?: OverlayOptions } = {
        component,
      };
      if (options !== undefined) entry.options = options;
      overlays.push(entry);
      return {
        hide: () => {
          const index = overlays.indexOf(entry);
          if (index !== -1) overlays.splice(index, 1);
        },
        setHidden: () => {},
        isHidden: () => !overlays.includes(entry),
      };
    },
    hideOverlay: () => {
      overlays.pop();
    },
  } as unknown as TUI;
  return { tui, renderCount: () => renders, overlays };
}
