import { describe, expect, test } from "bun:test";
import { command, KeyTrie, prefix } from "./keymap";

describe("KeyTrie", () => {
  test("runs a bound command", () => {
    let runs = 0;
    const trie = new KeyTrie({ j: command(() => runs++) });

    trie.handleInput("j");

    expect(runs).toBe(1);
  });

  test("an unbound key is ignored", () => {
    let runs = 0;
    let pendingChanges = 0;
    const trie = new KeyTrie({ j: command(() => runs++) }, () => {
      pendingChanges++;
    });

    trie.handleInput("x");

    expect(runs).toBe(0);
    expect(pendingChanges).toBe(0);
    expect(trie.pending).toBe("");
  });

  test("a prefix pends and completing the chord runs the child command", () => {
    let runs = 0;
    const trie = new KeyTrie({
      g: prefix({ g: command(() => runs++) }),
    });

    trie.handleInput("g");
    expect(trie.pending).toBe("g");
    expect(runs).toBe(0);

    trie.handleInput("g");
    expect(runs).toBe(1);
    expect(trie.pending).toBe("");
  });

  test("an unknown key after a prefix drops the chord", () => {
    let runs = 0;
    const trie = new KeyTrie({
      g: prefix({ g: command(() => runs++) }),
    });

    trie.handleInput("g");
    trie.handleInput("x");

    expect(trie.pending).toBe("");
    expect(runs).toBe(0);
  });

  test("onPendingChange fires exactly when the held chord appears and clears", () => {
    const changes: string[] = [];
    const trie = new KeyTrie({ g: prefix({ g: command(() => {}) }) }, () =>
      changes.push(trie.pending),
    );

    trie.handleInput("g");
    expect(changes).toEqual(["g"]);

    trie.handleInput("g");
    expect(changes).toEqual(["g", ""]);

    trie.handleInput("x"); // unknown key with no chord held: no callback
    expect(changes).toEqual(["g", ""]);
  });
});
