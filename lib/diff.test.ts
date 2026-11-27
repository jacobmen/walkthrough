import { describe, expect, test } from "bun:test";

import { parseHunkHeader, unquoteGitPath } from "./diff";

describe("parseHunkHeader", () => {
  test("parses start-only form with count defaulting to 1", () => {
    expect(parseHunkHeader("@@ -3 +7 @@")).toEqual({
      oldStart: 3,
      oldCount: 1,
      newStart: 7,
      newCount: 1,
    });
  });

  test("parses start,count form", () => {
    expect(parseHunkHeader("@@ -1,5 +2,3 @@")).toEqual({
      oldStart: 1,
      oldCount: 5,
      newStart: 2,
      newCount: 3,
    });
  });

  test("returns null for non-hunk input", () => {
    expect(parseHunkHeader("+++ b/f.ts")).toBeNull();
  });
});

describe("unquoteGitPath", () => {
  test("leaves unquoted input untouched", () => {
    expect(unquoteGitPath("src/a.ts")).toBe("src/a.ts");
  });

  test("decodes standard escapes", () => {
    expect(unquoteGitPath('"a\\tb\\nc"')).toBe("a\tb\nc");
  });

  test("keeps a backslash before an unmapped character", () => {
    expect(unquoteGitPath('"a\\\\z"')).toBe("a\\z");
  });

  test("decodes octal escapes capped at three digits", () => {
    expect(unquoteGitPath('"\\101\\1021"')).toBe("AB1");
  });

  test("drops a trailing backslash", () => {
    expect(unquoteGitPath('"ab\\"')).toBe("ab");
  });
});
