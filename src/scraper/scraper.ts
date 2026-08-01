import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { fetchHtml, fetchBinary } from './fetch';
import { parseProblemPage } from './parse';
import { Block, CachedProblem } from './types';

// ── Paths ─────────────────────────────────────────────────────────────────────
// __dirname at runtime = dist/scraper — go up two levels to reach src/problems

let statementsDir: string;
let imagesDir: string;

export function initScraperDirs(extensionPath: string): void {
  statementsDir = path.join(extensionPath, 'src', 'problems', 'local-problem-statements');
  imagesDir     = path.join(statementsDir, 'images');
  fs.mkdirSync(statementsDir, { recursive: true });
  fs.mkdirSync(imagesDir,     { recursive: true });
}

// ── URL helpers ───────────────────────────────────────────────────────────────

const CF_BASE = 'https://codeforces.com';

/**
 * Parses a Codeforces problem URL into contestId + index.
 * Supports:
 *   https://codeforces.com/contest/1234/problem/A
 *   https://codeforces.com/problemset/problem/1234/A
 */
export function parseProblemUrl(problemUrl: string): { contestId: number; index: string } | null {
  const contestMatch = /\/contest\/(\d+)\/problem\/([A-Z0-9]+)/i.exec(problemUrl);
  if (contestMatch) {
    return { contestId: Number(contestMatch[1]), index: contestMatch[2].toUpperCase() };
  }
  const psMatch = /\/problemset\/problem\/(\d+)\/([A-Z0-9]+)/i.exec(problemUrl);
  if (psMatch) {
    return { contestId: Number(psMatch[1]), index: psMatch[2].toUpperCase() };
  }
  return null;
}

/** Builds the canonical CF problem URL from contestId + index. */
export function buildProblemUrl(contestId: number, index: string): string {
  return `${CF_BASE}/contest/${contestId}/problem/${index}`;
}

/** Returns the cache file path for a problem. */
export function problemCachePath(contestId: number, index: string): string {
  return path.join(statementsDir, `${contestId}-${index}.json`);
}

/** Returns true if a valid cached file already exists. */
export function isCached(contestId: number, index: string): boolean {
  return !!statementsDir && fs.existsSync(problemCachePath(contestId, index));
}

/** Reads a cached problem. Returns null if not found. */
export function readCache(contestId: number, index: string): CachedProblem | null {
  try {
    return JSON.parse(fs.readFileSync(problemCachePath(contestId, index), 'utf-8')) as CachedProblem;
  } catch {
    return null;
  }
}

// ── Image downloader ──────────────────────────────────────────────────────────

async function downloadImage(src: string, problemKey: string): Promise<string> {
  const absUrl = src.startsWith('http') ? src : new URL(src, CF_BASE).href;
  const parsedUrl = new URL(absUrl);
  const ext  = path.extname(parsedUrl.pathname) || '.png';
  const safe = src.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-40);
  const fileName = `${problemKey}_${safe}${safe.endsWith(ext) ? '' : ext}`;
  const destPath = path.join(imagesDir, fileName);

  if (!fs.existsSync(destPath)) {
    const buf = await fetchBinary(absUrl);
    fs.writeFileSync(destPath, buf);
  }
  return `images/${fileName}`;
}

async function rewriteImages(blocks: Block[], problemKey: string): Promise<void> {
  for (const block of blocks) {
    if (block.type === 'image') {
      try {
        block.src = await downloadImage(block.src, problemKey);
      } catch (e) {
        console.warn(`[scraper] Failed to download image ${block.src}: ${e}`);
      }
    }
  }
}

// ── Main scrape function ──────────────────────────────────────────────────────

/**
 * Scrapes a Codeforces problem page, saves structured JSON + images,
 * and returns the CachedProblem object.
 *
 * @param contestId
 * @param index
 * @param force  Re-scrape even if already cached (default: false)
 */
export async function scrapeProblem(
  contestId: number,
  index: string,
  force = false
): Promise<CachedProblem> {
  const problemKey = `${contestId}-${index}`;

  if (!force && isCached(contestId, index)) {
    const cached = readCache(contestId, index);
    if (cached) { return cached; }
  }

  const problemUrl = buildProblemUrl(contestId, index);
  console.log(`[scraper] Fetching ${problemUrl}`);
  const html = await fetchHtml(problemUrl);

  const statement = parseProblemPage(html);
  if (!statement) {
    throw new Error(`Could not parse problem statement from ${problemUrl}`);
  }

  // Download images in every section
  const sections: Block[][] = [
    statement.description,
    statement.input,
    statement.output,
    ...(statement.note ? [statement.note] : []),
  ];
  for (const section of sections) {
    await rewriteImages(section, problemKey);
  }

  const cached: CachedProblem = {
    contestId,
    index,
    cachedAt: Math.floor(Date.now() / 1000),
    version: 1,
    statement,
  };

  fs.writeFileSync(problemCachePath(contestId, index), JSON.stringify(cached, null, 2), 'utf-8');
  console.log(`[scraper] Saved ${problemKey}.json`);
  return cached;
}
