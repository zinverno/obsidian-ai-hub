export interface BoundedHeadings {
  headingPath: string[];
  headingPathTruncated: boolean;
  totalHeadings: number;
}

/** Bound hostile heading metadata without changing the underlying Markdown. */
export function boundedHeadings(headings: readonly string[]): BoundedHeadings {
  const selected = headings.slice(0, 16);
  let truncated = headings.length > selected.length;
  const headingPath = selected.map((heading) => {
    const points = Array.from(heading);
    if (points.length > 256) truncated = true;
    return points.slice(0, 256).join("");
  });
  return { headingPath, headingPathTruncated: truncated, totalHeadings: headings.length };
}
