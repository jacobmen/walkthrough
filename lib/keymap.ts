import { matchesKey, type KeyId } from "@oh-my-pi/pi-tui";

export type KeyCommand = { kind: "command"; run: () => void };
export type KeyPrefix = { kind: "prefix"; children: Keymap };
export type KeyBinding = KeyCommand | KeyPrefix;
export type Keymap = { [K in KeyId]?: KeyBinding };

export function command(run: () => void): KeyBinding {
  return { kind: "command", run };
}

export function prefix(children: Keymap): KeyBinding {
  return { kind: "prefix", children };
}

/**
 * Key trie: owns the keymap and the held chord (a prefix key waiting for the
 * rest of its sequence).
 */
export class KeyTrie {
  readonly #root: Keymap;
  readonly #onPendingChange: (() => void) | undefined;
  #pending: { keys: KeyId[]; keymap: Keymap } | null = null;

  constructor(keymap: Keymap, onPendingChange?: () => void) {
    this.#root = keymap;
    this.#onPendingChange = onPendingChange;
  }

  get pending(): string {
    return this.#pending === null ? "" : this.#pending.keys.join("");
  }

  handleInput(data: string): void {
    const hadPending = this.#pending !== null;
    const match = this.#match(data);
    if (match === undefined) {
      this.#reset();
      if (hadPending) this.#onPendingChange?.();
      return;
    }

    if (match.node.kind === "prefix") {
      this.#pending = {
        keys: [...(this.#pending?.keys ?? []), match.key],
        keymap: match.node.children,
      };
      this.#onPendingChange?.();
      return;
    }

    this.#reset();
    match.node.run();
    if (hadPending) this.#onPendingChange?.();
  }

  #reset(): void {
    this.#pending = null;
  }

  #match(data: string): { key: KeyId; node: KeyBinding } | undefined {
    const keymap = this.#pending?.keymap ?? this.#root;
    for (const key of Object.keys(keymap) as KeyId[]) {
      const node = keymap[key];
      if (node !== undefined && matchesKey(data, key)) return { key, node };
    }
    return undefined;
  }
}
