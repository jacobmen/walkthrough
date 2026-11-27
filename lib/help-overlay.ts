import {
  Box,
  type Component,
  Text,
  type Theme,
  visibleWidth,
} from "@oh-my-pi/pi-tui";

import { command, KeyTrie } from "./keymap";

export type HelpEntry = { label: string; description: string };

/** Small bordered window listing every keybinding, one per line. */
export class HelpOverlay implements Component {
  readonly width: number;
  readonly #keys: KeyTrie;
  readonly #box: Box;

  constructor(
    theme: Theme,
    entries: readonly HelpEntry[],
    onClose: () => void,
  ) {
    const maxLabelWidth = Math.max(
      0,
      ...entries.map((entry) => visibleWidth(entry.label)),
    );
    const rows = entries.map((entry) => {
      const label = theme.fg("accent", entry.label.padEnd(maxLabelWidth));
      return `${label}  ${entry.description}`;
    });
    this.width = Math.max(0, ...rows.map(visibleWidth)) + 4;

    this.#keys = new KeyTrie({
      q: command(onClose),
      "ctrl+c": command(onClose),
      escape: command(onClose),
      "?": command(onClose),
    });

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text), {
      chars: {
        topLeft: "╭",
        topRight: "╮",
        bottomLeft: "╰",
        bottomRight: "╯",
        horizontal: "─",
        vertical: "│",
      },
      color: (text) => theme.fg("dim", text),
    });
    box.setIgnoreTight(true);
    for (const row of rows) {
      box.addChild(new Text(row, 0, 0));
    }
    this.#box = box;
  }

  render(width: number): readonly string[] {
    return this.#box.render(Math.min(width, this.width));
  }

  handleInput(data: string): void {
    this.#keys.handleInput(data);
  }
}
