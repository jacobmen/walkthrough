import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type FileStatus = "modified" | "new" | "deleted";

export type FileKind = "text" | "binary";

export type DiffLine =
  | {
      kind: "context";
      content: string;
      oldLine: number;
      newLine: number;
      comment?: string;
    }
  | { kind: "add"; content: string; newLine: number; comment?: string }
  | { kind: "del"; content: string; oldLine: number; comment?: string };

export function diffLineNumber(line: DiffLine): number {
  return line.kind === "del" ? line.oldLine : line.newLine;
}

export interface DiffHunk {
  header: string; // raw "@@ -10,5 +10,6 @@" text
  lines: DiffLine[];
}

export type DiffFile =
  | { kind: "text"; path: string; status: FileStatus; hunks: DiffHunk[] }
  | { kind: "binary"; path: string; status: FileStatus };

interface HunkState {
  header: string;
  oldLine: number;
  newLine: number;
  oldLeft: number;
  newLeft: number;
  lines: DiffLine[];
}

interface PendingFile {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  kind: FileKind;
  hunks: DiffHunk[];
}

/** Capture the unstaged working-tree diff (tracked changes plus untracked files), parsed. */
export async function captureDiff(
  exec: ExtensionAPI["exec"],
  cwd: string,
): Promise<DiffFile[]> {
  const rootResult = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (rootResult.code !== 0) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const root = rootResult.stdout.trim();
  if (!root) {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  const diffResult = await exec(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
    ],
    { cwd },
  );
  const files = parseDiff(diffResult.stdout, root, cwd);

  const untracked = await exec(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd },
  );
  if (untracked.code === 0) {
    for (const gitPath of untracked.stdout.split("\0")) {
      if (!gitPath) continue;
      const abs = path.resolve(root, gitPath);
      let content: string;
      try {
        const file = Bun.file(abs);
        const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
        if (head.includes(0)) continue; // TODO: see if there's a better way to determine binary or not
        content = await file.text();
      } catch {
        continue; // unreadable — skip
      }

      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) continue; // empty new file — nothing to review
      const diffLines: DiffLine[] = lines.map((lineContent, i) => ({
        kind: "add",
        content: lineContent,
        newLine: i + 1,
      }));
      files.push({
        kind: "text",
        path: displayPath(gitPath, root, cwd),
        status: "new",
        hunks: [
          { header: `@@ -0,0 +1,${diffLines.length} @@`, lines: diffLines },
        ],
      });
    }
  }

  return files;
}

function parseDiff(text: string, root: string, cwd: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: PendingFile | null = null;
  let hunk: HunkState | null = null;

  const finish = () => {
    if (!file) return;
    const gitPath =
      file.newPath && file.newPath !== "/dev/null"
        ? file.newPath
        : file.oldPath;
    if (gitPath && gitPath !== "/dev/null") {
      const display = displayPath(gitPath, root, cwd);
      if (file.kind === "binary") {
        files.push({ kind: "binary", path: display, status: file.status });
      } else if (file.hunks.length > 0) {
        files.push({
          kind: "text",
          path: display,
          status: file.status,
          hunks: file.hunks,
        });
      }
      // else: mode-only or empty change — skip
    }
    file = null;
    hunk = null;
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      finish();
      // Binary files have no ---/+++ lines; the diff --git line is their only path source.
      const fallback = parseDiffGitPaths(raw);
      file = {
        oldPath: fallback?.oldPath ?? "",
        newPath: fallback?.newPath ?? "",
        status: "modified",
        kind: "text",
        hunks: [],
      };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("@@ ")) {
      const parsed = parseHunkHeader(raw);
      if (parsed) {
        hunk = {
          header: raw,
          oldLine: parsed.oldStart,
          newLine: parsed.newStart,
          oldLeft: parsed.oldCount,
          newLeft: parsed.newCount,
          lines: [],
        };
        file.hunks.push({ header: raw, lines: hunk.lines });
      } else {
        hunk = null;
      }
      continue;
    }

    // Hunk content: consume while the header's counts have lines left ("\ No newline" rides along).
    if (
      hunk &&
      (hunk.oldLeft > 0 || hunk.newLeft > 0 || raw.startsWith("\\"))
    ) {
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
      const marker = raw[0];
      if (marker === "+") {
        hunk.lines.push({
          kind: "add",
          content: raw.slice(1),
          newLine: hunk.newLine++,
        });
        hunk.newLeft--;
      } else if (marker === "-") {
        hunk.lines.push({
          kind: "del",
          content: raw.slice(1),
          oldLine: hunk.oldLine++,
        });
        hunk.oldLeft--;
      } else if (marker === " ") {
        hunk.lines.push({
          kind: "context",
          content: raw.slice(1),
          oldLine: hunk.oldLine++,
          newLine: hunk.newLine++,
        });
        hunk.oldLeft--;
        hunk.newLeft--;
      } else if (raw !== "") {
        hunk = null; // unexpected — leave hunk-consumption mode
      }
      continue;
    }

    // File metadata.
    if (raw.startsWith("new file mode")) {
      file.status = "new";
    } else if (raw.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (raw.startsWith("rename from ")) {
      file.oldPath = unquoteGitPath(raw.slice("rename from ".length));
    } else if (raw.startsWith("rename to ")) {
      file.newPath = unquoteGitPath(raw.slice("rename to ".length));
    } else if (raw.startsWith("--- ")) {
      file.oldPath = parseDiffFilePath(raw, "--- ");
    } else if (raw.startsWith("+++ ")) {
      file.newPath = parseDiffFilePath(raw, "+++ ");
    } else if (
      raw.startsWith("Binary files ") ||
      raw.startsWith("GIT binary patch")
    ) {
      file.kind = "binary";
    }
    // index / old mode / new mode / similarity / dissimilarity — skip
  }
  finish();
  return files;
}

/**
 * Extract `{ oldPath, newPath }` from `diff --git a/<old> b/<new>`.
 * Ambiguous with spaces in paths, so used only as a fallback when the
 * unambiguous ---/+++ lines are absent (binary files).
 */
function parseDiffGitPaths(
  raw: string,
): { oldPath: string; newPath: string } | null {
  const rest = raw.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (m) {
      return {
        oldPath: stripAbPrefix(unquoteGitPath(`"${m[1]}"`)),
        newPath: stripAbPrefix(unquoteGitPath(`"${m[2]}"`)),
      };
    }
  }
  // Equal-path even split: rest === "a/" + P + " b/" + P.
  if (rest.startsWith("a/") && (rest.length - 5) % 2 === 0) {
    const lenP = (rest.length - 5) / 2;
    const p = rest.slice(2, 2 + lenP);
    if (rest === `a/${p} b/${p}`) return { oldPath: p, newPath: p };
  }
  const idx = rest.indexOf(" b/");
  if (idx > 2)
    return { oldPath: rest.slice(2, idx), newPath: rest.slice(idx + 3) };
  return null;
}

function stripAbPrefix(p: string): string {
  const two = p.slice(0, 2);
  return two === "a/" || two === "b/" ? p.slice(2) : p;
}

function parseHunkHeader(raw: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
  if (!m) return null;
  return {
    oldStart: Number.parseInt(m[1]!, 10),
    oldCount: m[2] === undefined ? 1 : Number.parseInt(m[2], 10),
    newStart: Number.parseInt(m[3]!, 10),
    newCount: m[4] === undefined ? 1 : Number.parseInt(m[4], 10),
  };
}

/** Parse a `--- a/<path>` / `+++ b/<path>` line into a repo-root-relative path. */
function parseDiffFilePath(raw: string, prefix: string): string {
  let rest = raw.slice(prefix.length).trim();
  if (rest.startsWith('"')) {
    rest = unquoteGitPath(rest);
  }
  const two = rest.slice(0, 2);
  if (two === "a/" || two === "b/") rest = rest.slice(2);
  return rest;
}

/** Undo git's C-style path quoting ("path\u00e9" etc.). Leaves unquoted input untouched. */
function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    switch (next) {
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "v":
        out += "\v";
        break;
      default:
        if (next >= "0" && next <= "7") {
          let oct = next;
          while (
            oct.length < 3 &&
            body[i + 1] !== undefined &&
            body[i + 1]! >= "0" &&
            body[i + 1]! <= "7"
          ) {
            oct += body[++i]!;
          }
          out += String.fromCharCode(Number.parseInt(oct, 8));
        } else {
          out += next;
        }
    }
  }
  return out;
}

/** Repo-root-relative git path → cwd-relative display path. */
function displayPath(gitPath: string, root: string, cwd: string): string {
  const rel = path.relative(cwd, path.resolve(root, gitPath));
  return rel || gitPath;
}
