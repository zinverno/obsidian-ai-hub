import type { CachedMetadata, HeadingCache } from "obsidian";
import { stableHash } from "./hash";
import { DEFAULT_CHUNKING_OPTIONS } from "./types";
import type {
  ChunkingOptions,
  ChunkingStrategy,
  MarkdownChunkInput,
  NoteChunk,
} from "./types";

interface SourceLine {
  index: number;
  startOffset: number;
  contentEndOffset: number;
  fullEndOffset: number;
  text: string;
}

interface HeadingInfo {
  level: number;
  text: string;
  startOffset: number;
  bodyStartOffset: number;
  lineIndex: number;
}

interface Section {
  headingPath: string[];
  startOffset: number;
  endOffset: number;
}

type BlockKind = "paragraph" | "code" | "list" | "quote" | "table" | "html";

interface LogicalBlock {
  kind: BlockKind;
  atomic: boolean;
  startOffset: number;
  endOffset: number;
  text: string;
  separatorBefore: string;
}

interface BlockGroup {
  primary: LogicalBlock[];
  oversized: boolean;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

interface ListMarker {
  indent: number;
  kind: "ordered" | "unordered";
}

// A small atomic block may exceed the soft overlap budget, but never maxChars.
const ATOMIC_OVERLAP_SLACK_CHARS = 80;

function scanLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  let lineIndex = 0;

  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const fullLineEnd =
      newline === -1 ? content.length : newline + 1;
    let contentEnd =
      newline === -1 ? content.length : newline;
    if (contentEnd > cursor && content.charCodeAt(contentEnd - 1) === 13) {
      contentEnd--;
    }
    lines.push({
      index: lineIndex,
      startOffset: cursor,
      contentEndOffset: contentEnd,
      fullEndOffset: fullLineEnd,
      text: content.slice(cursor, contentEnd),
    });
    cursor = fullLineEnd;
    lineIndex++;
  }

  return lines;
}

function linesInRange(
  lines: SourceLine[],
  startOffset: number,
  endOffset: number,
): SourceLine[] {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lines[middle].fullEndOffset <= startOffset) low = middle + 1;
    else high = middle;
  }

  const result: SourceLine[] = [];
  for (let index = low; index < lines.length; index++) {
    const line = lines[index];
    if (line.startOffset >= endOffset) break;
    result.push(line);
  }
  return result;
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/[ \t]+/g, " ");
}

function parseAtxHeading(line: string): { level: number; text: string } | null {
  const match = /^( {0,3})(#{1,6})(.*)$/.exec(line);
  if (!match) return null;
  const rest = match[3];
  if (rest && !/^[ \t]/.test(rest)) return null;

  const withoutClosingMarker = rest
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, "");
  return {
    level: match[2].length,
    text: normalizeHeading(withoutClosingMarker),
  };
}

function parseFenceOpen(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker: "`" | "~" = match[1][0] === "`" ? "`" : "~";
  if (marker === "`" && match[2].includes("`")) return null;
  return { marker, length: match[1].length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length,
  );
}

function scanHeadings(
  lines: SourceLine[],
  contentStart: number,
): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let fence: Fence | null = null;

  for (const line of lines) {
    if (line.startOffset < contentStart) continue;
    if (fence) {
      if (isFenceClose(line.text, fence)) fence = null;
      continue;
    }

    const openedFence = parseFenceOpen(line.text);
    if (openedFence) {
      fence = openedFence;
      continue;
    }

    const parsed = parseAtxHeading(line.text);
    if (!parsed) continue;
    headings.push({
      level: parsed.level,
      text: parsed.text,
      startOffset: line.startOffset,
      bodyStartOffset: line.fullEndOffset,
      lineIndex: line.index,
    });
  }

  return headings;
}

function isFiniteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

function locationMatchesLine(
  line: SourceLine | undefined,
  location: { line: number; col: number; offset: number },
): boolean {
  return Boolean(
    line &&
      isFiniteInteger(location.line) &&
      isFiniteInteger(location.col) &&
      isFiniteInteger(location.offset) &&
      location.line === line.index &&
      location.offset >= line.startOffset &&
      location.offset <= line.contentEndOffset &&
      location.col === location.offset - line.startOffset,
  );
}

function isValidSetextContentLine(
  sourceText: string,
  cachedText: string,
): boolean {
  if (!cachedText) return false;

  const leadingSpaces = /^ */.exec(sourceText)?.[0].length ?? 0;
  if (leadingSpaces > 3 || sourceText[leadingSpaces] === "\t") return false;

  const normalizedSource = normalizeHeading(sourceText);
  return Boolean(normalizedSource && normalizedSource === cachedText);
}

function cachedHeadingInfo(
  content: string,
  lines: SourceLine[],
  heading: HeadingCache,
): HeadingInfo | null {
  if (
    !heading ||
    typeof heading.heading !== "string" ||
    !heading.position?.start ||
    !heading.position.end ||
    !isFiniteInteger(heading.level) ||
    heading.level < 1 ||
    heading.level > 6
  ) {
    return null;
  }

  const { start, end } = heading.position;
  const startLine = lines[start.line];
  const endLine = lines[end.line];
  if (
    !locationMatchesLine(startLine, start) ||
    !locationMatchesLine(endLine, end) ||
    start.offset !== startLine.startOffset ||
    end.offset <= start.offset ||
    end.offset > content.length
  ) {
    return null;
  }

  const cachedText = normalizeHeading(heading.heading);
  const atx = parseAtxHeading(startLine.text);
  if (
    atx &&
    atx.level === heading.level &&
    atx.text === cachedText &&
    end.line === start.line &&
    end.offset === startLine.contentEndOffset
  ) {
    return {
      level: heading.level,
      text: cachedText,
      startOffset: start.offset,
      bodyStartOffset: startLine.fullEndOffset,
      lineIndex: start.line,
    };
  }

  const underlineLine = lines[start.line + 1];
  const underline = underlineLine
    ? /^ {0,3}(=+|-+)[ \t]*$/.exec(underlineLine.text)
    : null;
  const setextLevel = underline?.[1][0] === "=" ? 1 : 2;
  if (
    !underlineLine ||
    !underline ||
    heading.level !== setextLevel ||
    !isValidSetextContentLine(startLine.text, cachedText) ||
    end.line !== underlineLine.index ||
    end.offset !== underlineLine.contentEndOffset
  ) {
    return null;
  }

  return {
    level: heading.level,
    text: cachedText,
    startOffset: start.offset,
    bodyStartOffset: underlineLine.fullEndOffset,
    lineIndex: start.line,
  };
}

function cachedHeadingsIfValid(
  content: string,
  lines: SourceLine[],
  contentStart: number,
  cache: CachedMetadata | null | undefined,
): HeadingInfo[] | null {
  const cached = cache?.headings;
  if (!cached) return null;

  let previousBodyStart = contentStart;
  const result: HeadingInfo[] = [];
  for (const heading of cached) {
    const info = cachedHeadingInfo(content, lines, heading);
    if (
      !info ||
      info.startOffset < contentStart ||
      info.startOffset < previousBodyStart
    ) {
      return null;
    }
    previousBodyStart = info.bodyStartOffset;
    result.push(info);
  }
  return result;
}

function isFrontmatterOpeningLine(text: string): boolean {
  return text === "---" || text === "\uFEFF---";
}

function isFrontmatterClosingLine(text: string): boolean {
  return text === "---";
}

function detectFrontmatter(
  lines: SourceLine[],
): { bodyStart: number; closingLine: SourceLine } | null {
  if (!lines.length || !isFrontmatterOpeningLine(lines[0].text)) return null;
  for (let index = 1; index < lines.length; index++) {
    if (isFrontmatterClosingLine(lines[index].text)) {
      return {
        bodyStart: lines[index].fullEndOffset,
        closingLine: lines[index],
      };
    }
  }
  return null;
}

function cachedFrontmatterBodyStart(
  content: string,
  lines: SourceLine[],
  cache: CachedMetadata | null | undefined,
): number | null {
  const position = cache?.frontmatterPosition;
  if (!position) return null;
  const { start, end } = position;
  const closingLine = lines[end.line];
  const valid =
    Boolean(closingLine) &&
    isFiniteInteger(start.offset) &&
    isFiniteInteger(end.offset) &&
    isFiniteInteger(start.line) &&
    isFiniteInteger(end.line) &&
    isFiniteInteger(start.col) &&
    isFiniteInteger(end.col) &&
    start.offset === 0 &&
    start.line === 0 &&
    start.col === 0 &&
    isFrontmatterOpeningLine(lines[0]?.text ?? "") &&
    end.line > 0 &&
    isFrontmatterClosingLine(closingLine?.text ?? "") &&
    locationMatchesLine(lines[0], start) &&
    locationMatchesLine(closingLine, end) &&
    end.offset === closingLine.contentEndOffset &&
    end.offset <= content.length &&
    end.offset > start.offset;
  return valid && closingLine ? closingLine.fullEndOffset : null;
}

function contentStartAfterFrontmatter(
  content: string,
  lines: SourceLine[],
  cache: CachedMetadata | null | undefined,
): number {
  const fromCache = cachedFrontmatterBodyStart(content, lines, cache);
  if (fromCache !== null) return fromCache;
  return detectFrontmatter(lines)?.bodyStart ?? 0;
}

function rootHeading(path: string): string {
  const basename = path.split("/").pop() ?? path;
  return normalizeHeading(basename.replace(/\.md$/i, "")) || "Untitled";
}

function buildSections(
  path: string,
  contentLength: number,
  contentStart: number,
  headings: HeadingInfo[],
): Section[] {
  const sections: Section[] = [];
  const firstHeadingStart = headings[0]?.startOffset ?? contentLength;
  sections.push({
    headingPath: [rootHeading(path)],
    startOffset: contentStart,
    endOffset: firstHeadingStart,
  });

  const stack: Array<{ level: number; text: string }> = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    stack.push({ level: heading.level, text: heading.text });
    const headingPath = stack.map((entry) => entry.text).filter(Boolean);
    sections.push({
      headingPath: headingPath.length ? headingPath : [rootHeading(path)],
      startOffset: heading.bodyStartOffset,
      endOffset: headings[index + 1]?.startOffset ?? contentLength,
    });
  }

  return sections;
}

function isBlank(line: SourceLine): boolean {
  return line.text.trim().length === 0;
}

function parseListMarker(text: string): ListMarker | null {
  const match = /^( *)([-+*]|\d+[.)])[ \t]+/.exec(text);
  if (!match) return null;
  return {
    indent: match[1].length,
    kind: /^\d/.test(match[2]) ? "ordered" : "unordered",
  };
}

function isListStart(text: string): boolean {
  const marker = parseListMarker(text);
  return Boolean(marker && marker.indent <= 3);
}

function listBlockEnd(lines: SourceLine[], start: number): number {
  const rootMarker = parseListMarker(lines[start].text);
  if (!rootMarker) return start + 1;

  let index = start + 1;
  while (index < lines.length) {
    if (!isBlank(lines[index])) {
      index++;
      continue;
    }

    const blankStart = index;
    while (index < lines.length && isBlank(lines[index])) index++;
    if (index >= lines.length) return blankStart;

    const nextMarker = parseListMarker(lines[index].text);
    const continues =
      nextMarker &&
      (nextMarker.indent > rootMarker.indent ||
        (nextMarker.indent === rootMarker.indent &&
          nextMarker.kind === rootMarker.kind));
    if (!continues) return blankStart;
    index++;
  }
  return index;
}

function isQuoteStart(text: string): boolean {
  return /^ {0,3}>/.test(text);
}

function isHtmlStart(text: string): boolean {
  return /^ {0,3}<(?:!--|\/?[A-Za-z][\w-]*(?:\s|>|\/))/.test(text);
}

function isTableDelimiter(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function isTableStart(lines: SourceLine[], index: number): boolean {
  return Boolean(
    lines[index]?.text.includes("|") &&
    lines[index + 1] &&
    isTableDelimiter(lines[index + 1].text),
  );
}

function normalizePlainText(raw: string): string {
  const normalizedLines = raw.replace(/\r\n?/g, "\n").split("\n");
  const result: string[] = [];
  let blankRun = 0;

  for (const originalLine of normalizedLines) {
    const line = originalLine.replace(/[ \t]+$/, "");
    if (!line.trim()) {
      blankRun++;
      if (result.length && blankRun <= 2) result.push("");
      continue;
    }
    blankRun = 0;
    result.push(line);
  }
  while (result.length && result[result.length - 1] === "") result.pop();
  return result.join("\n");
}

function makeBlock(
  content: string,
  lines: SourceLine[],
  startIndex: number,
  endIndex: number,
  kind: BlockKind,
  atomic: boolean,
): LogicalBlock | null {
  const first = lines[startIndex];
  const last = lines[endIndex - 1];
  if (!first || !last) return null;
  const raw = content.slice(first.startOffset, last.contentEndOffset);
  const text =
    kind === "code" ? raw.replace(/\r\n?/g, "\n") : normalizePlainText(raw);
  if (!text.trim()) return null;
  return {
    kind,
    atomic,
    startOffset: first.startOffset,
    endOffset: last.contentEndOffset,
    text,
    separatorBefore: "\n\n",
  };
}

function parseLogicalBlocks(
  content: string,
  allLines: SourceLine[],
  startOffset: number,
  endOffset: number,
): LogicalBlock[] {
  const lines = linesInRange(allLines, startOffset, endOffset);
  const blocks: LogicalBlock[] = [];
  let index = 0;

  const pushBlock = (
    start: number,
    end: number,
    kind: BlockKind,
    atomic: boolean,
  ) => {
    const block = makeBlock(content, lines, start, end, kind, atomic);
    if (block) blocks.push(block);
  };

  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index++;
      continue;
    }

    const fence = parseFenceOpen(lines[index].text);
    if (fence) {
      const start = index++;
      while (index < lines.length) {
        const closes = isFenceClose(lines[index].text, fence);
        index++;
        if (closes) break;
      }
      pushBlock(start, index, "code", true);
      continue;
    }

    if (isTableStart(lines, index)) {
      const start = index;
      index += 2;
      while (
        index < lines.length &&
        !isBlank(lines[index]) &&
        lines[index].text.includes("|")
      ) {
        index++;
      }
      pushBlock(start, index, "table", true);
      continue;
    }

    if (isListStart(lines[index].text)) {
      const start = index;
      index = listBlockEnd(lines, start);
      pushBlock(start, index, "list", true);
      continue;
    }

    const groupedKind: BlockKind | null = isQuoteStart(lines[index].text)
      ? "quote"
      : isHtmlStart(lines[index].text)
        ? "html"
        : null;
    if (groupedKind) {
      const start = index++;
      while (index < lines.length && !isBlank(lines[index])) index++;
      pushBlock(start, index, groupedKind, true);
      continue;
    }

    const start = index++;
    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !parseFenceOpen(lines[index].text) &&
      !isTableStart(lines, index) &&
      !isListStart(lines[index].text) &&
      !isQuoteStart(lines[index].text) &&
      !isHtmlStart(lines[index].text)
    ) {
      index++;
    }
    pushBlock(start, index, "paragraph", false);
  }

  return blocks;
}

function joinBlocks(blocks: LogicalBlock[]): string {
  let result = "";
  for (let index = 0; index < blocks.length; index++) {
    if (index) result += blocks[index].separatorBefore;
    result += blocks[index].text;
  }
  return result;
}

function composeText(breadcrumb: string, blocks: LogicalBlock[]): string {
  return `${breadcrumb}\n\n${joinBlocks(blocks)}`;
}

function closestBoundary(candidates: number[], target: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance && candidate > (best ?? -1))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function chooseParagraphBoundary(
  content: string,
  start: number,
  target: number,
  maximum: number,
): number {
  const window = content.slice(start, maximum);
  const sentenceCandidates: number[] = [];
  const sentence = /[.!?…](?:["'»”)\]]*)?(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = sentence.exec(window))) {
    const boundary = start + match.index + match[0].length;
    if (boundary > start + 20) sentenceCandidates.push(boundary);
  }
  const sentenceBoundary = closestBoundary(sentenceCandidates, target);
  if (sentenceBoundary !== null) return sentenceBoundary;

  const whitespaceCandidates: number[] = [];
  const whitespace = /\s+/g;
  while ((match = whitespace.exec(window))) {
    const boundary = start + match.index;
    if (boundary > start) whitespaceCandidates.push(boundary);
  }
  return closestBoundary(whitespaceCandidates, target) ?? maximum;
}

function isBetweenSurrogatePair(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  const previous = content.charCodeAt(offset - 1);
  const next = content.charCodeAt(offset);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

function safeEndBoundary(
  content: string,
  offset: number,
  minimum: number,
  maximum: number,
): number {
  if (!isBetweenSurrogatePair(content, offset)) return offset;
  if (offset - 1 > minimum) return offset - 1;
  // A code point is indivisible: the first surrogate pair may exceed max by one
  // UTF-16 unit; groupBlocks then marks that minimal overflow as oversized.
  return Math.min(maximum, offset + 1);
}

function safeStartBoundary(
  content: string,
  offset: number,
  minimum: number,
): number {
  // Include the whole code point, allowing at most one UTF-16 unit of overlap slack.
  return isBetweenSurrogatePair(content, offset)
    ? Math.max(minimum, offset - 1)
    : offset;
}

function splitLongParagraph(
  content: string,
  block: LogicalBlock,
  targetBodyChars: number,
  maxBodyChars: number,
): LogicalBlock[] {
  if (block.text.length <= maxBodyChars) return [block];

  const pieces: LogicalBlock[] = [];
  let cursor = block.startOffset;
  let previousBoundary = block.startOffset;
  while (cursor < block.endOffset) {
    while (cursor < block.endOffset && /\s/.test(content[cursor])) cursor++;
    if (cursor >= block.endOffset) break;

    const maximum = Math.min(block.endOffset, cursor + maxBodyChars);
    const target = Math.min(maximum, cursor + targetBodyChars);
    let boundary =
      maximum === block.endOffset
        ? block.endOffset
        : chooseParagraphBoundary(content, cursor, target, maximum);
    boundary = safeEndBoundary(content, boundary, cursor, block.endOffset);
    if (boundary <= cursor) boundary = maximum;

    let trimmedEnd = boundary;
    while (trimmedEnd > cursor && /\s/.test(content[trimmedEnd - 1])) {
      trimmedEnd--;
    }
    const text = normalizePlainText(content.slice(cursor, trimmedEnd));
    if (text) {
      const gap = content.slice(previousBoundary, cursor).replace(/\r\n?/g, "\n");
      pieces.push({
        kind: "paragraph",
        atomic: false,
        startOffset: cursor,
        endOffset: trimmedEnd,
        text,
        separatorBefore:
          pieces.length === 0
            ? block.separatorBefore
            : gap.includes("\n")
              ? "\n"
              : " ",
      });
    }
    previousBoundary = boundary;
    cursor = boundary;
  }

  return pieces;
}

function prepareBlocks(
  content: string,
  blocks: LogicalBlock[],
  breadcrumb: string,
  options: ChunkingOptions,
): LogicalBlock[] {
  const prefixLength = breadcrumb.length + 2;
  const maxBodyChars = Math.max(1, options.maxChars - prefixLength);
  const targetBodyChars = Math.max(1, options.targetChars - prefixLength);
  return blocks.flatMap((block) =>
    block.kind === "paragraph"
      ? splitLongParagraph(content, block, targetBodyChars, maxBodyChars)
      : [block],
  );
}

function groupBlocks(
  blocks: LogicalBlock[],
  breadcrumb: string,
  options: ChunkingOptions,
): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: LogicalBlock[] = [];

  const flush = () => {
    if (!current.length) return;
    const length = composeText(breadcrumb, current).length;
    groups.push({ primary: current, oversized: length > options.maxChars });
    current = [];
  };

  for (const block of blocks) {
    const standaloneLength = composeText(breadcrumb, [block]).length;
    if (block.atomic && standaloneLength > options.maxChars) {
      flush();
      groups.push({ primary: [block], oversized: true });
      continue;
    }
    if (!current.length) {
      current = [block];
      continue;
    }

    const currentLength = composeText(breadcrumb, current).length;
    const combined = [...current, block];
    const combinedLength = composeText(breadcrumb, combined).length;
    const combinedIsCloser =
      Math.abs(combinedLength - options.targetChars) <=
      Math.abs(currentLength - options.targetChars);
    if (
      combinedLength <= options.maxChars &&
      (combinedLength <= options.targetChars || combinedIsCloser)
    ) {
      current = combined;
    } else {
      flush();
      current = [block];
    }
  }
  flush();
  return groups;
}

function suffixOverlapBlock(
  content: string,
  block: LogicalBlock,
  budget: number,
): LogicalBlock | null {
  if (block.atomic || budget <= 0) return null;
  let start = Math.max(block.startOffset, block.endOffset - budget);
  start = safeStartBoundary(content, start, block.startOffset);
  if (start > block.startOffset && !/\s/.test(content[start - 1])) {
    while (start < block.endOffset && !/\s/.test(content[start])) start++;
  }
  while (start < block.endOffset && /\s/.test(content[start])) start++;
  const text = normalizePlainText(content.slice(start, block.endOffset));
  if (!text) return null;
  return {
    ...block,
    startOffset: start,
    text,
  };
}

function selectOverlap(
  content: string,
  previousPrimary: LogicalBlock[],
  primary: LogicalBlock[],
  breadcrumb: string,
  options: ChunkingOptions,
): LogicalBlock[] {
  const primaryLength = composeText(breadcrumb, primary).length;
  const bridgeLength = primary[0]?.separatorBefore.length ?? 0;
  const hardBudget = Math.max(
    0,
    options.maxChars - primaryLength - bridgeLength,
  );
  const softBudget = Math.min(options.overlapChars, hardBudget);
  if (!softBudget || !previousPrimary.length) return [];

  let overlap: LogicalBlock[] = [];
  for (let index = previousPrimary.length - 1; index >= 0; index--) {
    const candidate = [previousPrimary[index], ...overlap];
    if (joinBlocks(candidate).length > softBudget) break;
    overlap = candidate;
  }
  if (overlap.length) return overlap;

  const last = previousPrimary[previousPrimary.length - 1];
  if (
    last.atomic &&
    last.text.length <=
      Math.min(hardBudget, options.overlapChars + ATOMIC_OVERLAP_SLACK_CHARS)
  ) {
    return [last];
  }
  const suffix = suffixOverlapBlock(content, last, softBudget);
  return suffix ? [suffix] : [];
}

function lineAtOffset(lines: SourceLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = lines[middle];
    if (offset < line.startOffset) high = middle - 1;
    else if (offset >= line.fullEndOffset) low = middle + 1;
    else return line.index;
  }
  return lines[Math.max(0, Math.min(lines.length - 1, high))]?.index ?? 0;
}

function validateOptions(options: ChunkingOptions): void {
  if (
    !isFiniteInteger(options.targetChars) ||
    !isFiniteInteger(options.maxChars) ||
    !isFiniteInteger(options.overlapChars) ||
    options.targetChars <= 0 ||
    options.maxChars < options.targetChars ||
    options.overlapChars < 0 ||
    options.overlapChars >= options.maxChars
  ) {
    throw new RangeError(
      "Chunking options require 0 < targetChars <= maxChars and 0 <= overlapChars < maxChars.",
    );
  }
}

export class MarkdownChunker implements ChunkingStrategy {
  private readonly options: ChunkingOptions;

  constructor(options: Partial<ChunkingOptions> = {}) {
    this.options = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
    validateOptions(this.options);
  }

  chunk(input: MarkdownChunkInput): NoteChunk[] {
    if (typeof input.path !== "string" || typeof input.content !== "string") {
      throw new TypeError(
        "MarkdownChunker requires string path and content values.",
      );
    }

    const { path, content, cache } = input;
    if (!content.length) return [];
    const allLines = scanLines(content);
    const contentStart = contentStartAfterFrontmatter(content, allLines, cache);
    const headings =
      cachedHeadingsIfValid(content, allLines, contentStart, cache) ??
      scanHeadings(allLines, contentStart);
    const sections = buildSections(
      path,
      content.length,
      contentStart,
      headings,
    );

    const chunks: NoteChunk[] = [];
    const duplicateOccurrences = new Map<string, number>();

    for (const section of sections) {
      const parsedBlocks = parseLogicalBlocks(
        content,
        allLines,
        section.startOffset,
        section.endOffset,
      );
      if (!parsedBlocks.length) continue;
      const breadcrumb = section.headingPath.join(" > ");
      const blocks = prepareBlocks(
        content,
        parsedBlocks,
        breadcrumb,
        this.options,
      );
      const groups = groupBlocks(blocks, breadcrumb, this.options);
      let previousPrimary: LogicalBlock[] = [];

      for (const group of groups) {
        const overlap = previousPrimary.length
          ? selectOverlap(
              content,
              previousPrimary,
              group.primary,
              breadcrumb,
              this.options,
            )
          : [];
        const included = [...overlap, ...group.primary];
        const text = composeText(breadcrumb, included);
        const contentHash = stableHash(text);
        const identity = `${path}\u0000${JSON.stringify(section.headingPath)}\u0000${contentHash}`;
        const occurrence = duplicateOccurrences.get(identity) ?? 0;
        duplicateOccurrences.set(identity, occurrence + 1);
        const startOffset = included[0].startOffset;
        const endOffset = included[included.length - 1].endOffset;
        const chunk: NoteChunk = {
          id: `chunk-${stableHash(`${identity}\u0000${occurrence}`)}`,
          path,
          ordinal: chunks.length,
          headingPath: [...section.headingPath],
          text,
          contentHash,
          source: {
            startOffset,
            endOffset,
            startLine: lineAtOffset(allLines, startOffset),
            endLine: lineAtOffset(allLines, Math.max(startOffset, endOffset - 1)),
          },
        };
        if (group.oversized || text.length > this.options.maxChars) {
          chunk.oversized = true;
        }
        chunks.push(chunk);
        previousPrimary = group.primary;
      }
    }

    return chunks;
  }
}
