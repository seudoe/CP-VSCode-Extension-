import { Block, Example, ProblemStatement } from './types';

// ── Minimal HTML helpers ─────────────────────────────────────────────────────

/** Extract the inner HTML of the first element matching a CSS-like selector substring. */
function extractInner(html: string, tag: string, className: string): string | null {
  // Match <tag ... class="...className..." ...> ... </tag>
  // We use a simple approach: find the class, then walk brackets to find end tag.
  const classPattern = new RegExp(
    `<${tag}[^>]*class="[^"]*${escapeRegex(className)}[^"]*"[^>]*>`,
    'i'
  );
  const match = classPattern.exec(html);
  if (!match) { return null; }

  const start = match.index + match[0].length;
  return extractUntilClosingTag(html, tag, start);
}

/** Given a position just after an opening tag, find the matching closing tag. */
function extractUntilClosingTag(html: string, tag: string, start: number): string {
  let depth = 1;
  let i = start;
  const openTag = new RegExp(`<${tag}[\\s>]`, 'gi');
  const closeTag = new RegExp(`</${tag}>`, 'gi');

  while (i < html.length && depth > 0) {
    openTag.lastIndex = i;
    closeTag.lastIndex = i;
    const nextOpen = openTag.exec(html);
    const nextClose = closeTag.exec(html);

    if (!nextClose) { break; }

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(start, nextClose.index);
      }
      i = nextClose.index + nextClose[0].length;
    }
  }

  return html.slice(start);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip HTML tags, collapse whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Block parser ─────────────────────────────────────────────────────────────

/**
 * Converts a raw inner HTML section (e.g. the content of .legend) into
 * a structured Block array.
 */
export function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  let remaining = html.trim();

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (!remaining) { break; }

    // ── <img>
    const imgMatch = /^<img([^>]*)>/i.exec(remaining);
    if (imgMatch) {
      const attrs = imgMatch[1];
      const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const alt = /alt="([^"]+)"/.exec(attrs)?.[1];
      if (src) {
        blocks.push({ type: 'image', src, alt });
      }
      remaining = remaining.slice(imgMatch[0].length);
      continue;
    }

    // ── <table
    if (/^<table/i.test(remaining)) {
      const end = remaining.toLowerCase().indexOf('</table>');
      if (end !== -1) {
        const tableHtml = remaining.slice(0, end + '</table>'.length);
        blocks.push({ type: 'table', html: tableHtml });
        remaining = remaining.slice(tableHtml.length);
      } else {
        remaining = '';
      }
      continue;
    }

    // ── <ul> or <ol>
    const listMatch = /^<(ul|ol)[^>]*>/i.exec(remaining);
    if (listMatch) {
      const listTag = listMatch[1].toLowerCase();
      const ordered = listTag === 'ol';
      const inner = extractUntilClosingTag(remaining, listTag, listMatch[0].length);
      const items: string[] = [];
      const liRe = /<li[^>]*>(.*?)<\/li>/gis;
      let liMatch: RegExpExecArray | null;
      while ((liMatch = liRe.exec(inner)) !== null) {
        items.push(stripTags(liMatch[1]));
      }
      blocks.push({ type: 'list', ordered, items });
      remaining = remaining.slice(listMatch[0].length + inner.length + `</${listTag}>`.length);
      continue;
    }

    // ── <pre> → code block
    const preMatch = /^<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(remaining);
    if (preMatch) {
      blocks.push({ type: 'code', code: stripTags(preMatch[1]) });
      remaining = remaining.slice(preMatch[0].length);
      continue;
    }

    // ── <p> or <div> → paragraph (preserve inner HTML for math/formatting)
    const blockTagMatch = /^<(p|div)[^>]*>/i.exec(remaining);
    if (blockTagMatch) {
      const bTag = blockTagMatch[1].toLowerCase();
      const inner = extractUntilClosingTag(remaining, bTag, blockTagMatch[0].length);
      const trimmed = inner.trim();
      if (trimmed) {
        // Check if it's a nested image-only block
        if (/^<img[^>]*>$/i.test(trimmed)) {
          const src = /src="([^"]+)"/.exec(trimmed)?.[1] ?? '';
          const alt = /alt="([^"]+)"/.exec(trimmed)?.[1];
          if (src) { blocks.push({ type: 'image', src, alt }); }
        } else {
          blocks.push({ type: 'paragraph', html: trimmed });
        }
      }
      remaining = remaining.slice(blockTagMatch[0].length + inner.length + `</${bTag}>`.length);
      continue;
    }

    // ── Skip any other tag (span, br, etc.) or plain text
    const nextTag = /^<[^>]+>/.exec(remaining);
    if (nextTag) {
      remaining = remaining.slice(nextTag[0].length);
    } else {
      // Plain text node — wrap as paragraph
      const nextTagStart = remaining.indexOf('<');
      const text = nextTagStart === -1 ? remaining : remaining.slice(0, nextTagStart);
      const trimmed = text.trim();
      if (trimmed) {
        blocks.push({ type: 'paragraph', html: trimmed });
      }
      remaining = nextTagStart === -1 ? '' : remaining.slice(nextTagStart);
    }
  }

  return blocks;
}

// ── Example parser ────────────────────────────────────────────────────────────

function extractSampleTests(html: string): Example[] {
  const examples: Example[] = [];

  // Each test is a .sample-test div containing .input and .output
  const sampleTestRe = /<div[^>]*class="[^"]*sample-test[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = sampleTestRe.exec(html)) !== null) {
    const sampleStart = match.index + match[0].length;
    const sampleInner = extractUntilClosingTag(html, 'div', sampleStart);

    const inputInner = extractInner(sampleInner, 'div', 'input') ?? '';
    const outputInner = extractInner(sampleInner, 'div', 'output') ?? '';
    const noteInner = extractInner(sampleInner, 'div', 'note') ?? '';

    // Inside .input/.output there's a <pre> with the actual content
    const inputPre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(inputInner)?.[1] ?? '';
    const outputPre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(outputInner)?.[1] ?? '';

    const example: Example = {
      input: stripTags(inputPre).replace(/\r\n/g, '\n'),
      output: stripTags(outputPre).replace(/\r\n/g, '\n'),
    };

    const noteText = stripTags(noteInner).trim();
    if (noteText) {
      example.explanation = noteText;
    }

    examples.push(example);
  }

  return examples;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/** Parse a Codeforces problem page HTML into a structured ProblemStatement. */
export function parseProblemPage(html: string): ProblemStatement | null {
  // Find .problem-statement
  const psInner = extractInner(html, 'div', 'problem-statement');
  if (!psInner) {
    return null;
  }

  // ── Header fields
  const titleRaw = extractInner(psInner, 'div', 'title') ?? '';
  const title = stripTags(titleRaw).trim();

  const timeLimitRaw = extractInner(psInner, 'div', 'time-limit') ?? '';
  // "time limit per test" prefix — strip it
  const timeLimit = stripTags(timeLimitRaw).replace(/time limit per test/i, '').trim();

  const memoryLimitRaw = extractInner(psInner, 'div', 'memory-limit') ?? '';
  const memoryLimit = stripTags(memoryLimitRaw).replace(/memory limit per test/i, '').trim();

  // ── Sections
  const legendRaw = extractInner(psInner, 'div', 'legend') ?? '';
  const description = parseBlocks(legendRaw);

  const inputSpecRaw = extractInner(psInner, 'div', 'input-specification') ?? '';
  // Remove the "Input" header div that CF wraps inside
  const inputSpecClean = inputSpecRaw.replace(/<div[^>]*class="[^"]*section-title[^"]*"[^>]*>[\s\S]*?<\/div>/i, '');
  const input = parseBlocks(inputSpecClean);

  const outputSpecRaw = extractInner(psInner, 'div', 'output-specification') ?? '';
  const outputSpecClean = outputSpecRaw.replace(/<div[^>]*class="[^"]*section-title[^"]*"[^>]*>[\s\S]*?<\/div>/i, '');
  const output = parseBlocks(outputSpecClean);

  const examples = extractSampleTests(psInner);

  const noteRaw = extractInner(psInner, 'div', 'note') ?? '';
  const noteClean = noteRaw.replace(/<div[^>]*class="[^"]*section-title[^"]*"[^>]*>[\s\S]*?<\/div>/i, '');
  const noteBlocks = parseBlocks(noteClean);

  const result: ProblemStatement = {
    title,
    timeLimit,
    memoryLimit,
    description,
    input,
    output,
    examples,
  };

  if (noteBlocks.length > 0) {
    result.note = noteBlocks;
  }

  return result;
}
