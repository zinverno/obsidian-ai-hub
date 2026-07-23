import { describe, expect, it } from "vitest";
import type { CachedMetadata, HeadingCache, Loc, Pos } from "obsidian";
import { stableHash } from "./hash";
import { MarkdownChunker } from "./markdownChunker";

const defaultChunker = new MarkdownChunker();

function locationAt(content: string, offset: number): Loc {
  const prefix = content.slice(0, offset);
  const line = (prefix.match(/\n/g) ?? []).length;
  const lastNewline = prefix.lastIndexOf("\n");
  return { line, col: offset - lastNewline - 1, offset };
}

function position(content: string, start: number, end: number): Pos {
  return {
    start: locationAt(content, start),
    end: locationAt(content, end),
  };
}

function validHeadingCache(content: string): CachedMetadata {
  const headings: HeadingCache[] = [];
  const pattern = /^(#{1,6})[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const line = match[0].replace(/\r$/, "");
    const start = match.index;
    const heading = match[2]
      .trim()
      .replace(/[ \t]+#+[ \t]*$/, "")
      .trim();
    headings.push({
      heading,
      level: match[1].length,
      position: position(content, start, start + line.length),
    });
  }
  return { headings };
}

function cachedSetextHeading(
  content: string,
  heading: string,
  level: 1 | 2,
  endOffset: number,
): CachedMetadata {
  return {
    headings: [
      {
        heading,
        level,
        position: position(content, 0, endOffset),
      },
    ],
  };
}

function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

function chunkBody(text: string): string {
  return text.slice(text.indexOf("\n\n") + 2);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      !(
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      )
    ) {
      return true;
    }
    if (
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff &&
      !(
        index > 0 &&
        value.charCodeAt(index - 1) >= 0xd800 &&
        value.charCodeAt(index - 1) <= 0xdbff
      )
    ) {
      return true;
    }
  }
  return false;
}

function isInsideSurrogatePair(content: string, offset: number): boolean {
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

function byHeading(
  chunks: ReturnType<MarkdownChunker["chunk"]>,
  heading: string,
) {
  const found = chunks.find(
    (chunk) => chunk.headingPath[chunk.headingPath.length - 1] === heading,
  );
  expect(found).toBeDefined();
  if (!found) throw new Error(`Missing chunk for heading: ${heading}`);
  return found;
}

describe("MarkdownChunker basics and sections", () => {
  it("returns no chunks for an empty file", () => {
    expect(defaultChunker.chunk({ path: "Empty.md", content: "" })).toEqual([]);
  });

  it("returns no chunks for whitespace only", () => {
    expect(
      defaultChunker.chunk({ path: "Empty.md", content: " \n\t\r\n" }),
    ).toEqual([]);
  });

  it("returns no chunks for a frontmatter-only file", () => {
    const content = "---\ntags: [ai]\n---\n";
    expect(defaultChunker.chunk({ path: "Meta.md", content })).toEqual([]);
  });

  it("removes frontmatter but keeps root text", () => {
    const content = "---\nstatus: active\n---\n\nВводная информация.";
    const [chunk] = defaultChunker.chunk({ path: "Projects/AI Hub.md", content });
    expect(chunk.headingPath).toEqual(["AI Hub"]);
    expect(chunk.text).toBe("AI Hub\n\nВводная информация.");
    expect(chunk.text).not.toContain("status:");
    expect(content.slice(chunk.source.startOffset, chunk.source.endOffset)).toBe(
      "Вводная информация.",
    );
  });

  it("uses the filename as root heading when there are no headings", () => {
    const [chunk] = defaultChunker.chunk({
      path: "Notes/Overview.md",
      content: "Only root content.",
    });
    expect(chunk.headingPath).toEqual(["Overview"]);
    expect(chunk.text).toBe("Overview\n\nOnly root content.");
  });

  it("builds H1, H2 and H3 hierarchy without duplicating child bodies", () => {
    const content = [
      "# AI Hub",
      "Root body.",
      "## Architecture",
      "Architecture body.",
      "### VectorStore",
      "Vector body.",
    ].join("\n");
    const chunks = defaultChunker.chunk({ path: "AI Hub.md", content });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["AI Hub"],
      ["AI Hub", "Architecture"],
      ["AI Hub", "Architecture", "VectorStore"],
    ]);
    expect(chunks[1].text).not.toContain("Vector body.");
  });

  it("supports skipped heading levels", () => {
    const chunks = defaultChunker.chunk({
      path: "AI.md",
      content: "# AI Hub\n### VectorStore\nBody.",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(["AI Hub", "VectorStore"]);
  });

  it("pops the hierarchy when returning from H3 to H2", () => {
    const content = "# A\n## B\n### C\nC body.\n## D\nD body.";
    const chunks = defaultChunker.chunk({ path: "Tree.md", content });
    expect(byHeading(chunks, "D").headingPath).toEqual(["A", "D"]);
  });

  it("creates a root chunk for text before the first heading", () => {
    const chunks = defaultChunker.chunk({
      path: "Projects/AI Hub.md",
      content: "Intro.\n\n# Architecture\nDetails.",
    });
    expect(chunks[0].headingPath).toEqual(["AI Hub"]);
    expect(chunks[0].text).toContain("Intro.");
    expect(chunks[1].headingPath).toEqual(["Architecture"]);
  });

  it("skips headings without their own body", () => {
    const chunks = defaultChunker.chunk({
      path: "Empty section.md",
      content: "# Parent\n## Child\nChild body.",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(["Parent", "Child"]);
  });

  it("supports duplicate headings", () => {
    const content = "# Root\n## Same\nFirst.\n## Same\nSecond.";
    const chunks = defaultChunker.chunk({ path: "Duplicates.md", content });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["Root", "Same"],
      ["Root", "Same"],
    ]);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Root > Same\n\nFirst.",
      "Root > Same\n\nSecond.",
    ]);
  });
});

describe("Markdown syntax preservation", () => {
  it("does not treat a heading-like line inside a code fence as a heading", () => {
    const content = "Intro.\n\n```md\n# Not a heading\n```";
    const chunks = defaultChunker.chunk({ path: "Code.md", content });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(["Code"]);
    expect(chunks[0].text).toContain("# Not a heading");
  });

  it("preserves backtick fenced code with a language", () => {
    const content = "# Code\n```ts\nconst value = 1;\n```";
    const [chunk] = defaultChunker.chunk({ path: "Code.md", content });
    expect(chunk.text).toContain("```ts\nconst value = 1;\n```");
  });

  it("preserves tilde fenced code", () => {
    const content = "# Code\n~~~python\nprint('ok')\n~~~";
    const [chunk] = defaultChunker.chunk({ path: "Code.md", content });
    expect(chunk.text).toContain("~~~python\nprint('ok')\n~~~");
  });

  it("treats an unclosed fence as code through the end of its section", () => {
    const content = "# Code\n```js\nconst value = 1;\n# Still code";
    const chunks = defaultChunker.chunk({ path: "Code.md", content });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# Still code");
  });

  it("normalizes CRLF while keeping 0-based source lines", () => {
    const content = "# Heading\r\nFirst.\r\nSecond.";
    const [chunk] = defaultChunker.chunk({ path: "CRLF.md", content });
    expect(chunk.text).toBe("Heading\n\nFirst.\nSecond.");
    expect(chunk.source.startLine).toBe(1);
    expect(chunk.source.endLine).toBe(2);
    expect(chunk.text).not.toContain("\r");
  });

  it("preserves Unicode and Cyrillic", () => {
    const [chunk] = defaultChunker.chunk({
      path: "Юникод.md",
      content: "# Знания 🧠\nСвязь между идеями — важна.",
    });
    expect(chunk.text).toBe("Знания 🧠\n\nСвязь между идеями — важна.");
  });

  it("preserves wiki-links", () => {
    const [chunk] = defaultChunker.chunk({
      path: "Links.md",
      content: "See [[Target]] and [[Target|Alias]].",
    });
    expect(chunk.text).toContain("[[Target]]");
    expect(chunk.text).toContain("[[Target|Alias]]");
  });

  it("preserves embeds", () => {
    const [chunk] = defaultChunker.chunk({
      path: "Embeds.md",
      content: "Context for ![[Embedded note]].",
    });
    expect(chunk.text).toContain("![[Embedded note]]");
  });

  it("keeps a Markdown list as one logical block", () => {
    const content = "# List\n- one\n  continuation\n- two\n- three";
    const [chunk] = defaultChunker.chunk({ path: "List.md", content });
    expect(chunk.text).toContain("- one\n  continuation\n- two\n- three");
  });

  it("keeps a blockquote and callout as one logical block", () => {
    const content = "# Quote\n> [!info] Title\n> First line\n> Second line";
    const [chunk] = defaultChunker.chunk({ path: "Quote.md", content });
    expect(chunk.text).toContain("> [!info] Title\n> First line\n> Second line");
  });

  it("keeps a Markdown table as one logical block", () => {
    const content = "# Table\n| Name | Value |\n| --- | ---: |\n| A | 1 |\n| B | 2 |";
    const [chunk] = defaultChunker.chunk({ path: "Table.md", content });
    expect(chunk.text).toContain("| --- | ---: |\n| A | 1 |");
  });

  it.each([
    ["list", "- one very long item\n- two very long items\n- three very long items"],
    ["callout", "> [!note] A long title\n> long quoted content\n> more quoted content"],
    ["table", "| Name | Value |\n| --- | --- |\n| Alpha | Long value |\n| Beta | Long value |"],
    ["HTML", "<div>\nA deliberately long HTML block that stays atomic.\n</div>"],
  ])("does not split an oversized atomic %s block", (_name, block) => {
    const chunker = new MarkdownChunker({
      targetChars: 50,
      maxChars: 60,
      overlapChars: 10,
    });
    const chunks = chunker.chunk({
      path: "Atomic.md",
      content: `# Atomic\n${block}`,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].oversized).toBe(true);
    expect(chunks[0].text).toContain(block);
  });

  it("does not mistake a horizontal rule in the body for frontmatter", () => {
    const content = "Intro.\n\n---\n\nOutro.";
    const [chunk] = defaultChunker.chunk({ path: "Rule.md", content });
    expect(chunk.text).toContain("Intro.");
    expect(chunk.text).toContain("---");
    expect(chunk.text).toContain("Outro.");
  });
});

describe("strict frontmatter detection", () => {
  it("supports BOM and CRLF with exact source offsets", () => {
    const content = "\uFEFF---\r\nstatus: active\r\n---\r\nVisible body.";
    const [chunk] = defaultChunker.chunk({ path: "Frontmatter.md", content });
    const bodyStart = content.indexOf("Visible body.");

    expect(chunk.text).toBe("Frontmatter\n\nVisible body.");
    expect(chunk.source).toEqual({
      startOffset: bodyStart,
      endOffset: content.length,
      startLine: 3,
      endLine: 3,
    });
    expect(content.slice(chunk.source.startOffset, chunk.source.endOffset)).toBe(
      "Visible body.",
    );
  });

  it.each(["  ---", "\t---"])(
    "does not remove frontmatter with a leading whitespace opener %j",
    (opening) => {
      const content = `${opening}\nsecret: yes\n---\nVisible.`;
      const chunks = defaultChunker.chunk({ path: "Literal.md", content });
      expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
        "secret: yes",
      );
      expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(opening);
    },
  );

  it("does not accept an indented closing delimiter", () => {
    const content = "---\nsecret: yes\n  ---\nVisible.";
    const [chunk] = defaultChunker.chunk({ path: "Literal.md", content });
    expect(chunk.text).toContain("secret: yes");
    expect(chunk.text).toContain("  ---");
    expect(chunk.text).toContain("Visible.");
    expect(chunk.source.startOffset).toBe(0);
  });

  it("keeps an unclosed frontmatter opener as ordinary content", () => {
    const content = "---\nsecret: yes\nVisible.";
    const [chunk] = defaultChunker.chunk({ path: "Literal.md", content });
    expect(chunk.text).toBe("Literal\n\n---\nsecret: yes\nVisible.");
    expect(chunk.source.startOffset).toBe(0);
  });
});

describe("loose and nested lists", () => {
  it("keeps a loose unordered list atomic including internal blank lines", () => {
    const list = "- first\n\n- second\n\n- third";
    const content = `# List\n${list}`;
    const [chunk] = defaultChunker.chunk({ path: "List.md", content });
    expect(chunkBody(chunk.text)).toBe(list);
    expect(content.slice(chunk.source.startOffset, chunk.source.endOffset)).toBe(
      list,
    );
  });

  it("keeps a loose ordered list atomic", () => {
    const list = "1. first\n\n2. second\n\n3. third";
    const [chunk] = defaultChunker.chunk({
      path: "List.md",
      content: `# List\n${list}`,
    });
    expect(chunkBody(chunk.text)).toBe(list);
  });

  it("keeps a nested list after a blank line in the same atomic block", () => {
    const list = "- parent\n\n    1. nested\n    2. nested two\n- sibling";
    const [chunk] = defaultChunker.chunk({
      path: "List.md",
      content: `# List\n${list}`,
    });
    expect(chunkBody(chunk.text)).toBe(list);
  });

  it("does not absorb a paragraph after a list", () => {
    const paragraph = `Paragraph ${words("word", 30)}`;
    const chunks = new MarkdownChunker({
      targetChars: 40,
      maxChars: 55,
      overlapChars: 0,
    }).chunk({
      path: "List.md",
      content: `# List\n- one\n\n${paragraph}`,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain("- one");
    expect(chunks[0].text).not.toContain("word29");
    expect(chunks.slice(1).some((chunk) => chunk.text.includes("word29"))).toBe(
      true,
    );
    expect(chunks.some((chunk) => chunk.text.includes("Paragraph"))).toBe(true);
    expect(chunks.every((chunk) => chunk.oversized !== true)).toBe(true);
  });

  it("does not absorb a following heading into a list", () => {
    const chunks = defaultChunker.chunk({
      path: "List.md",
      content: "# List\n- one\n\n# Next\nBody.",
    });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["List"],
      ["Next"],
    ]);
    expect(chunks[0].text).not.toContain("Next");
  });

  it("keeps one oversized loose list intact", () => {
    const list = `- ${words("first", 8)}\n\n- ${words("second", 8)}`;
    const [chunk] = new MarkdownChunker({
      targetChars: 45,
      maxChars: 60,
      overlapChars: 10,
    }).chunk({ path: "List.md", content: `# List\n${list}` });
    expect(chunk.oversized).toBe(true);
    expect(chunkBody(chunk.text)).toBe(list);
  });
});

describe("long sections, atomic blocks and overlap", () => {
  const smallOptions = { targetChars: 180, maxChars: 260, overlapChars: 45 };

  it("splits a long section without empty chunks", () => {
    const chunker = new MarkdownChunker(smallOptions);
    const chunks = chunker.chunk({
      path: "Long.md",
      content: `# Long\n${words("word", 100)}`,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= smallOptions.maxChars)).toBe(true);
  });

  it("never splits a fenced code block", () => {
    const chunker = new MarkdownChunker({
      targetChars: 100,
      maxChars: 180,
      overlapChars: 20,
    });
    const code = "```txt\n" + words("code", 18) + "\n```";
    const chunks = chunker.chunk({
      path: "Atomic.md",
      content: `# Atomic\nBefore paragraph.\n\n${code}\n\nAfter paragraph.`,
    });
    const containingFence = chunks.filter(
      (chunk) => chunk.text.includes("```") || chunk.text.includes("code0"),
    );
    expect(containingFence).toHaveLength(1);
    expect(containingFence[0].text).toContain(code);
  });

  it("marks one huge code block oversized and keeps it intact", () => {
    const chunker = new MarkdownChunker({
      targetChars: 100,
      maxChars: 160,
      overlapChars: 20,
    });
    const code = "```txt\n" + "x".repeat(300) + "\n```";
    const [chunk] = chunker.chunk({
      path: "Huge code.md",
      content: `# Code\n${code}`,
    });
    expect(chunk.oversized).toBe(true);
    expect(chunk.text).toContain(code);
  });

  it("adds overlap only after the first chunk of a section", () => {
    const chunker = new MarkdownChunker(smallOptions);
    const chunks = chunker.chunk({
      path: "Overlap.md",
      content: `# Topic\n${words("item", 120)}`,
    });
    expect(chunks.length).toBeGreaterThan(2);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].source.startOffset).toBeLessThan(
        chunks[index - 1].source.endOffset,
      );
    }
  });

  it("does not add overlap between different heading sections", () => {
    const chunks = defaultChunker.chunk({
      path: "Sections.md",
      content: "# A\nUnique A ending.\n# B\nUnique B beginning.",
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].text).not.toContain("Unique A ending.");
    expect(chunks[1].source.startOffset).toBeGreaterThanOrEqual(
      chunks[0].source.endOffset,
    );
  });

  it("never splits a UTF-16 surrogate pair at a hard boundary", () => {
    const body = "😀".repeat(30);
    const content = `# H\n${body}`;
    const chunks = new MarkdownChunker({
      targetChars: 20,
      maxChars: 24,
      overlapChars: 0,
    }).chunk({ path: "Unicode.md", content });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunkBody(chunk.text)).join("")).toBe(body);
    for (const chunk of chunks) {
      expect(hasLoneSurrogate(chunk.text)).toBe(false);
      expect(isInsideSurrogatePair(content, chunk.source.startOffset)).toBe(false);
      expect(isInsideSurrogatePair(content, chunk.source.endOffset)).toBe(false);
      expect(content.slice(chunk.source.startOffset, chunk.source.endOffset)).toBe(
        chunkBody(chunk.text),
      );
    }
  });

  it("allows only minimal oversized overflow for one indivisible emoji", () => {
    const content = "# H\n😀";
    const chunker = new MarkdownChunker({
      targetChars: 4,
      maxChars: 4,
      overlapChars: 0,
    });

    const first = chunker.chunk({ path: "Tiny Unicode.md", content });
    const second = chunker.chunk({ path: "Tiny Unicode.md", content });

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].text).toBe("H\n\n😀");
    expect(first[0].text).toHaveLength(5);
    expect(first[0].text.length - 4).toBe(1);
    expect(first[0].oversized).toBe(true);
    expect(hasLoneSurrogate(first[0].text)).toBe(false);
    expect(first[0].source).toEqual({
      startOffset: content.indexOf("😀"),
      endOffset: content.length,
      startLine: 1,
      endLine: 1,
    });
    expect(content.slice(first[0].source.startOffset, first[0].source.endOffset)).toBe(
      "😀",
    );
  });

  it("keeps an emoji whole when it is the direct suffix overlap", () => {
    const primary = "p".repeat(25);
    const content =
      "# H\nprefix 😀\n\n" + primary + "\n# Next\nNext body.";
    const chunks = new MarkdownChunker({
      targetChars: 15,
      maxChars: 40,
      overlapChars: 1,
    }).chunk({ path: "Unicode overlap.md", content });
    const hChunks = chunks.filter(
      (chunk) => chunk.headingPath[chunk.headingPath.length - 1] === "H",
    );
    const next = byHeading(chunks, "Next");

    expect(hChunks).toHaveLength(2);
    expect(chunkBody(hChunks[0].text)).toBe("prefix 😀");
    expect(chunkBody(hChunks[1].text)).toBe("😀\n\n" + primary);
    expect(hChunks[1].source.startOffset).toBe(content.indexOf("😀"));
    expect(
      isInsideSurrogatePair(content, hChunks[1].source.startOffset),
    ).toBe(false);
    expect(
      content.slice(hChunks[1].source.startOffset, hChunks[1].source.endOffset),
    ).toBe("😀\n\n" + primary);
    const reconstructedPrimary =
      chunkBody(hChunks[0].text) +
      "\n\n" +
      chunkBody(hChunks[1].text).slice("😀\n\n".length);
    expect(reconstructedPrimary).toBe("prefix 😀\n\n" + primary);
    expect(next.text).not.toContain("😀");
    expect(next.source.startOffset).toBeGreaterThanOrEqual(
      hChunks[1].source.endOffset,
    );
    expect(chunks.every((chunk) => !hasLoneSurrogate(chunk.text))).toBe(true);
  });

  it.each([39, 40, 41, 59, 60, 61])(
    "handles a final chunk length of %i around target and max boundaries",
    (finalLength) => {
      const body = "a".repeat(finalLength - 3);
      const chunks = new MarkdownChunker({
        targetChars: 40,
        maxChars: 60,
        overlapChars: 0,
      }).chunk({ path: "Boundary.md", content: `# H\n${body}` });

      expect(chunks.every((chunk) => chunk.text.length <= 60)).toBe(true);
      expect(chunks.map((chunk) => chunkBody(chunk.text)).join("")).toBe(body);
      if (finalLength <= 60) {
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toHaveLength(finalLength);
      } else {
        expect(chunks.length).toBeGreaterThan(1);
      }
    },
  );

  it.each([
    { length: 9, repeats: true },
    { length: 10, repeats: true },
    { length: 11, repeats: false },
  ])(
    "applies an overlap tail of $length characters around overlapChars",
    ({ length, repeats }) => {
      const tail = "x".repeat(length);
      const content = `# H\n${tail}\n\n${"second ".repeat(8).trim()}`;
      const chunks = new MarkdownChunker({
        targetChars: 18,
        maxChars: 38,
        overlapChars: 10,
      }).chunk({ path: "Overlap edge.md", content });
      expect(chunks.length).toBeGreaterThan(1);

      if (repeats) {
        expect(chunkBody(chunks[1].text).startsWith(`${tail}\n\n`)).toBe(true);
        expect(
          chunks[0].source.endOffset - chunks[1].source.startOffset,
        ).toBe(length);
      } else {
        expect(chunkBody(chunks[1].text)).not.toContain(tail);
        expect(chunks[1].source.startOffset).toBeGreaterThanOrEqual(
          chunks[0].source.endOffset,
        );
      }
    },
  );

  it("allows a small atomic overlap to use the named slack without exceeding max", () => {
    const list = "- atomic overlap";
    const paragraph = "p".repeat(40);
    const chunks = new MarkdownChunker({
      targetChars: 30,
      maxChars: 70,
      overlapChars: 10,
    }).chunk({
      path: "Atomic overlap.md",
      content: `# H\n${list}\n\n${paragraph}`,
    });
    expect(chunks).toHaveLength(2);
    expect(chunkBody(chunks[1].text)).toBe(`${list}\n\n${paragraph}`);
    expect(list.length).toBeGreaterThan(10);
    expect(chunks[1].text.length).toBeLessThanOrEqual(70);
  });

  it("covers primary text exactly and duplicates only the expected overlap", () => {
    const body = words("token", 80);
    const content = `# Cover\n${body}`;
    const chunks = new MarkdownChunker({
      targetChars: 70,
      maxChars: 90,
      overlapChars: 15,
    }).chunk({ path: "Coverage.md", content });
    const primaryParts: string[] = [];
    let previousEnd = content.indexOf("token0");

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      let primaryStart = previousEnd;
      while (/\s/.test(content[primaryStart] ?? "")) primaryStart++;
      const primary = content.slice(primaryStart, chunk.source.endOffset);
      const overlap = content.slice(chunk.source.startOffset, previousEnd);
      const expectedBody = overlap ? `${overlap} ${primary}` : primary;

      expect(chunkBody(chunk.text)).toBe(expectedBody);
      expect(content.slice(chunk.source.startOffset, previousEnd)).toBe(overlap);
      primaryParts.push(primary);
      previousEnd = chunk.source.endOffset;
    }

    expect(primaryParts.join(" ")).toBe(body);
    expect(previousEnd).toBe(content.length);
  });
});

describe("hashes, identifiers and source ranges", () => {
  it.each([
    ["", "811c9dc59e3779b9"],
    ["hello", "4f9f2cabc497deb1"],
    ["Привет 😀", "209c243cc27a9835"],
    ["Body.", "7a585661d97ed1a2"],
  ])("matches the stable 64-bit-like vector for %j", (value, expected) => {
    expect(stableHash(value)).toBe(expected);
    expect(stableHash(value)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces a stable content hash from final text", () => {
    const [first] = defaultChunker.chunk({ path: "Hash.md", content: "Body." });
    const [second] = defaultChunker.chunk({ path: "Hash.md", content: "Body." });
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toBe(stableHash(first.text));
    expect(stableHash("Body.")).not.toBe(stableHash("Changed."));
  });

  it("produces stable IDs and structurally identical repeated results", () => {
    const input = { path: "Stable.md", content: "# A\nAlpha.\n## B\nBeta." };
    const first = defaultChunker.chunk(input);
    expect(first).toEqual(defaultChunker.chunk(input));
    expect(first.every((chunk) => /^chunk-[0-9a-f]{16}$/.test(chunk.id))).toBe(
      true,
    );
  });

  it("does not change another section ID when one section changes", () => {
    const before = defaultChunker.chunk({
      path: "Stable.md",
      content: "# A\nAlpha.\n# B\nBeta.",
    });
    const after = defaultChunker.chunk({
      path: "Stable.md",
      content: "# A\nChanged alpha.\n# B\nBeta.",
    });
    expect(byHeading(before, "B").id).toBe(byHeading(after, "B").id);
    expect(byHeading(before, "A").id).not.toBe(byHeading(after, "A").id);
  });

  it("does not change later IDs when a new early section is inserted", () => {
    const original = "# A\nAlpha.\n# B\nBeta.";
    const before = defaultChunker.chunk({ path: "Stable.md", content: original });
    const after = defaultChunker.chunk({
      path: "Stable.md",
      content: "# New\nNew body.\n" + original,
    });
    expect(byHeading(before, "A").id).toBe(byHeading(after, "A").id);
    expect(byHeading(before, "B").id).toBe(byHeading(after, "B").id);
  });

  it("assigns different IDs to identical chunks in the same heading path", () => {
    const chunks = defaultChunker.chunk({
      path: "Duplicates.md",
      content: "# Root\n## Same\nRepeated.\n## Same\nRepeated.",
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].contentHash).toBe(chunks[1].contentHash);
    expect(chunks[0].id).not.toBe(chunks[1].id);
  });

  it("keeps every source range inside the original content", () => {
    const content = `# Long\n${words("source", 100)}`;
    const chunks = new MarkdownChunker({
      targetChars: 150,
      maxChars: 220,
      overlapChars: 35,
    }).chunk({ path: "Ranges.md", content });
    for (const chunk of chunks) {
      expect(chunk.source.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.source.startOffset).toBeLessThanOrEqual(chunk.source.endOffset);
      expect(chunk.source.endOffset).toBeLessThanOrEqual(content.length);
      expect(chunk.source.startLine).toBeGreaterThanOrEqual(0);
      expect(chunk.source.endLine).toBeGreaterThanOrEqual(chunk.source.startLine);
    }
  });

  it("includes breadcrumbs in text but not in the source range", () => {
    const content = "# AI Hub\n## MCP\nClaude gets access.";
    const [chunk] = defaultChunker.chunk({ path: "AI Hub.md", content });
    expect(chunk.text).toBe("AI Hub > MCP\n\nClaude gets access.");
    const source = content.slice(chunk.source.startOffset, chunk.source.endOffset);
    expect(source).toBe("Claude gets access.");
    expect(source).not.toContain("AI Hub > MCP");
  });
});

describe("metadata cache validation and immutability", () => {
  it("falls back when cached heading offsets are invalid", () => {
    const content = "# Real heading\nBody.";
    const cache: CachedMetadata = {
      headings: [
        {
          heading: "Wrong",
          level: 2,
          position: {
            start: { line: 0, col: 0, offset: -5 },
            end: { line: 0, col: 2, offset: 999 },
          },
        },
      ],
    };
    const [chunk] = defaultChunker.chunk({ path: "Fallback.md", content, cache });
    expect(chunk.headingPath).toEqual(["Real heading"]);
    expect(chunk.text).toContain("Body.");
  });

  it("uses valid cache instead of a conflicting fallback heading", () => {
    const content = [
      "<!--",
      "# Ignored inside HTML comment",
      "-->",
      "# AI Hub",
      "Intro.",
      "## MCP ###",
      "Body.",
    ].join("\n");
    const aiStart = content.indexOf("# AI Hub");
    const mcpStart = content.indexOf("## MCP ###");
    const cache: CachedMetadata = {
      headings: [
        {
          heading: "AI Hub",
          level: 1,
          position: position(content, aiStart, aiStart + "# AI Hub".length),
        },
        {
          heading: "MCP",
          level: 2,
          position: position(content, mcpStart, mcpStart + "## MCP ###".length),
        },
      ],
    };
    const chunks = defaultChunker.chunk({ path: "Cache Proof.md", content, cache });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["Cache Proof"],
      ["AI Hub"],
      ["AI Hub", "MCP"],
    ]);
    expect(
      chunks.some((chunk) => chunk.headingPath.includes("Ignored inside HTML comment")),
    ).toBe(false);
    expect(chunks[0].text).toContain("# Ignored inside HTML comment");
  });

  it("uses a valid cached Setext heading that fallback does not recognize", () => {
    const content = "Setext title\n============\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache: CachedMetadata = {
      headings: [
        {
          heading: "Setext title",
          level: 1,
          position: position(content, 0, underlineEnd),
        },
      ],
    };
    const [chunk] = defaultChunker.chunk({ path: "Setext.md", content, cache });
    expect(chunk.headingPath).toEqual(["Setext title"]);
    expect(chunk.text).toBe("Setext title\n\nBody.");
    expect(chunk.source.startOffset).toBe(content.indexOf("Body."));
  });

  it("accepts a valid level 2 cached Setext heading with CRLF", () => {
    const content = "Setext title\r\n-----\r\nBody.";
    const underlineEnd = content.indexOf("\r\nBody.");
    const cache = cachedSetextHeading(content, "Setext title", 2, underlineEnd);
    const [chunk] = defaultChunker.chunk({
      path: "Setext CRLF.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Setext title"]);
    expect(chunk.text).toBe("Setext title\n\nBody.");
    expect(chunk.source.startOffset).toBe(content.indexOf("Body."));
  });

  it.each([0, 1, 2, 3])(
    "accepts cached Setext content with %i leading ASCII spaces",
    (leadingSpaces) => {
      const content = " ".repeat(leadingSpaces) + "Title\n-----\nBody.";
      const underlineEnd = content.indexOf("\nBody.");
      const cache = cachedSetextHeading(content, "Title", 2, underlineEnd);
      const [chunk] = defaultChunker.chunk({
        path: "Setext indentation.md",
        content,
        cache,
      });

      expect(chunk.headingPath).toEqual(["Title"]);
      expect(chunk.text).toBe("Title\n\nBody.");
      expect(chunk.source.startOffset).toBe(content.indexOf("Body."));
    },
  );

  it("rejects a cached Setext heading with empty cached text", () => {
    const content = "Visible title\n-----\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache = cachedSetextHeading(content, "", 2, underlineEnd);
    const [chunk] = defaultChunker.chunk({
      path: "Empty cached.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Empty cached"]);
    expect(chunkBody(chunk.text)).toBe(content);
  });

  it("rejects a cached Setext heading with an empty source content line", () => {
    const content = "\n-\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache = cachedSetextHeading(content, "Ghost", 2, underlineEnd);
    const [chunk] = defaultChunker.chunk({
      path: "Empty source.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Empty source"]);
    expect(chunkBody(chunk.text)).toContain("-");
    expect(chunkBody(chunk.text)).toContain("Body.");
  });

  it("rejects four-space-indented cached Setext content as code", () => {
    const content = "    Code line\n---\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache = cachedSetextHeading(content, "Code line", 2, underlineEnd);
    const [chunk] = defaultChunker.chunk({
      path: "Indented code.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Indented code"]);
    expect(chunkBody(chunk.text)).toBe(content);
  });

  it("rejects tab-indented cached Setext content", () => {
    const content = "\tTabbed line\n---\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache = cachedSetextHeading(content, "Tabbed line", 2, underlineEnd);
    const [chunk] = defaultChunker.chunk({
      path: "Tabbed code.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Tabbed code"]);
    expect(chunkBody(chunk.text)).toBe(content);
  });

  it("falls back when a cached Setext end offset does not span the underline", () => {
    const content = "Visible title\n=====\nBody.";
    const underlineEnd = content.indexOf("\nBody.");
    const cache = cachedSetextHeading(
      content,
      "Visible title",
      1,
      underlineEnd - 1,
    );
    const [chunk] = defaultChunker.chunk({
      path: "Bad Setext range.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["Bad Setext range"]);
    expect(chunkBody(chunk.text)).toBe(content);
  });

  it("rejects the whole heading cache when one Setext entry is damaged", () => {
    const content = [
      "Valid cached",
      "=====",
      "First body.",
      "    Broken cached",
      "---",
      "Last body.",
    ].join("\n");
    const validEnd = content.indexOf("\nFirst body.");
    const brokenStart = content.indexOf("    Broken cached");
    const brokenEnd = content.indexOf("\nLast body.");
    const cache: CachedMetadata = {
      headings: [
        {
          heading: "Valid cached",
          level: 1,
          position: position(content, 0, validEnd),
        },
        {
          heading: "Broken cached",
          level: 2,
          position: position(content, brokenStart, brokenEnd),
        },
      ],
    };
    const cacheBefore = JSON.stringify(cache);
    const [chunk] = defaultChunker.chunk({
      path: "All or nothing.md",
      content,
      cache,
    });

    expect(chunk.headingPath).toEqual(["All or nothing"]);
    expect(chunkBody(chunk.text)).toBe(content);
    expect(chunk.text).toContain("Valid cached\n=====");
    expect(chunk.text).toContain("    Broken cached\n---");
    expect(JSON.stringify(cache)).toBe(cacheBefore);
  });

  it("accepts realistic CRLF HeadingCache offsets, lines and columns", () => {
    const content = "# Root\r\nRoot body.\r\n## Child\r\nChild body.";
    const childStart = content.indexOf("## Child");
    const cache: CachedMetadata = {
      headings: [
        {
          heading: "Root",
          level: 1,
          position: position(content, 0, "# Root".length),
        },
        {
          heading: "Child",
          level: 2,
          position: position(
            content,
            childStart,
            childStart + "## Child".length,
          ),
        },
      ],
    };
    const chunks = defaultChunker.chunk({ path: "CRLF cache.md", content, cache });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["Root"],
      ["Root", "Child"],
    ]);
    expect(chunks[1].source.startLine).toBe(3);
    expect(chunks[1].text).toBe("Root > Child\n\nChild body.");
  });

  it("uses a valid frontmatterPosition and excludes metadata", () => {
    const content = "---\ntags: [ai]\n---\n# Note\nBody.";
    const closingStart = content.indexOf("---", 3);
    const cache: CachedMetadata = {
      ...validHeadingCache(content),
      frontmatterPosition: position(content, 0, closingStart + 3),
    };
    const [chunk] = defaultChunker.chunk({ path: "Note.md", content, cache });
    expect(chunk.text).toBe("Note\n\nBody.");
    expect(chunk.source.startOffset).toBe(content.indexOf("Body."));
  });

  it("falls back when frontmatterPosition is invalid", () => {
    const content = "---\ntags: [ai]\n---\n# Note\nBody.";
    const cache: CachedMetadata = {
      ...validHeadingCache(content),
      frontmatterPosition: {
        start: { line: 0, col: 0, offset: -1 },
        end: { line: 99, col: 0, offset: 999 },
      },
    };
    const [chunk] = defaultChunker.chunk({ path: "Note.md", content, cache });
    expect(chunk.text).toBe("Note\n\nBody.");
  });

  it("does not mutate the input object or metadata cache", () => {
    const content = "# A\nBody.\n## B\nMore.";
    const cache = validHeadingCache(content);
    const input = { path: "Immutable.md", content, cache };
    const cacheBefore = JSON.stringify(cache);
    const inputBefore = JSON.stringify(input);
    defaultChunker.chunk(input);
    expect(JSON.stringify(cache)).toBe(cacheBefore);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });
});

describe("configuration", () => {
  it("rejects incoherent chunking options", () => {
    expect(
      () => new MarkdownChunker({ targetChars: 200, maxChars: 100 }),
    ).toThrow(RangeError);
    expect(() => new MarkdownChunker({ overlapChars: -1 })).toThrow(RangeError);
  });
});
