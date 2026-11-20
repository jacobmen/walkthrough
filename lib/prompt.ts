import { type DiffFile, type DiffLine, diffLineNumber } from "./diff";

type CommentedLine = DiffLine & { comment: string };

/**
 * Build the omp prompt from commented diff lines, grouped by file in diff order.
 * Returns "" when no comments exist.
 */
export function buildPrompt(files: DiffFile[]): string {
	const sections: string[] = [];
	for (const file of files) {
		if (file.kind !== "text") continue;
		const commented: CommentedLine[] = [];
		for (const hunk of file.hunks) {
			for (const line of hunk.lines) {
				const comment = line.comment?.trim();
				if (comment) {
					commented.push({ ...line, comment } as CommentedLine);
				}
			}
		}
		if (commented.length === 0) continue;
		const points = commented.map(line => {
			const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
			const snapshot = prefix + line.content;
			const removed = line.kind === "del" ? " (removed)" : "";
			return `- Line ${diffLineNumber(line)}${removed}: ${snapshot}\n  Comment: ${line.comment}`;
		});
		sections.push(`${file.path}:\n${points.join("\n")}`);
	}
	if (sections.length === 0) return "";
	return `Address each of the points below:\n\n${sections.join("\n\n")}\n`;
}
