export interface DiffLine { kind: "context" | "removed" | "added"; text: string }
/** Linear whole-note diff: common prefix/suffix are context; changed middle is explicit removal/addition. */
export function proposalDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  return [
    ...oldLines.slice(0, start).map((text): DiffLine => ({ kind: "context", text })),
    ...oldLines.slice(start, oldLines.length - end).map((text): DiffLine => ({ kind: "removed", text })),
    ...newLines.slice(start, newLines.length - end).map((text): DiffLine => ({ kind: "added", text })),
    ...oldLines.slice(oldLines.length - end).map((text): DiffLine => ({ kind: "context", text })),
  ];
}
