import type { CachedMetadata } from "obsidian";

export interface MarkdownChunkInput {
  path: string;
  content: string;
  cache?: CachedMetadata | null;
}

/**
 * Original Markdown body range. Offsets are half-open and lines are 0-based;
 * endLine is the line containing the final source character.
 */
export interface ChunkSourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface NoteChunk {
  id: string;
  path: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  contentHash: string;
  source: ChunkSourceRange;
  oversized?: boolean;
}

export interface ChunkingOptions {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
}

export interface ChunkingStrategy {
  chunk(input: MarkdownChunkInput): NoteChunk[];
}

export const DEFAULT_CHUNKING_OPTIONS: Readonly<ChunkingOptions> = {
  targetChars: 1200,
  maxChars: 1800,
  overlapChars: 200,
};
