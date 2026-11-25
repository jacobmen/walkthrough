import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { captureDiff } from "./lib/diff";
import { buildPrompt } from "./lib/prompt";
import { nonEmpty, WalkthroughViewer } from "./lib/viewer";

export default function walkthrough(pi: ExtensionAPI) {
  pi.registerCommand("walkthrough", {
    description: "Review changes file by file and collect feedback",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("walkthrough requires the interactive TUI", "error");
        return;
      }

      let files;
      try {
        files = await captureDiff(pi.exec, ctx.cwd);
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
        return;
      }

      if (!nonEmpty(files)) {
        ctx.ui.notify("No unstaged changes", "info");
        return;
      }

      await ctx.ui.custom(
        (tui, theme, _keybindings, done) =>
          new WalkthroughViewer(files, tui, theme, done),
        { overlay: true },
      );

      const prompt = buildPrompt(files);
      if (prompt) {
        ctx.ui.setEditorText(prompt);
      } else {
        ctx.ui.notify("No comments left — nothing to address", "info");
      }
    },
  });
}
