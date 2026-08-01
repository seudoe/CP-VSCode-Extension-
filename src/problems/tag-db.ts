import * as fs from 'fs';
import * as path from 'path';
import { CFProblem } from './cf-api';

export type TagGroup = Record<string, CFProblem[]>;

// Canonical tag list from tags.md — order preserved for sidebar display
export const KNOWN_TAGS = [
  'binary search',
  'bitmasks',
  'brute force',
  'chinese remainder theorem',
  'combinatorics',
  'communication',
  'constructive algorithms',
  'data structures',
  'dfs and similar',
  'divide and conquer',
  'dp',
  'dsu',
  'expression parsing',
  'fft',
  'flows',
  'games',
  'geometry',
  'graph matchings',
  'graphs',
  'greedy',
  'hashing',
  'implementation',
  'interactive',
  'math',
  'matrices',
  'meet in the middle',
  'number theory',
  'probabilities',
  'schedules',
  'shortest paths',
  'sortings',
  'special',
  'string suffix structures',
  'strings',
  'ternary search',
  'trees',
  'two pointers',
] as const;

export const OTHER_TAG_KEY = 'other';

let tagDbPath: string;

export function initTagDb(storagePath: string): void {
  tagDbPath = path.join(storagePath, 'local-database', 'tags.json');
}

export function readTagDb(): TagGroup {
  try {
    const raw = fs.readFileSync(tagDbPath, 'utf-8');
    return JSON.parse(raw) as TagGroup;
  } catch {
    return {};
  }
}

/**
 * Groups problems by tag, writes tags.json, returns the grouped map.
 * A problem with multiple tags appears under each of its tags.
 * Problems whose tags don't match any known tag go into "other".
 */
export function buildTagDb(problems: CFProblem[]): TagGroup {
  const groups: TagGroup = {};

  for (const tag of KNOWN_TAGS) {
    groups[tag] = [];
  }
  groups[OTHER_TAG_KEY] = [];

  for (const p of problems) {
    if (!p.tags || p.tags.length === 0) {
      groups[OTHER_TAG_KEY].push(p);
      continue;
    }

    let matched = false;
    for (const tag of p.tags) {
      const normalized = tag.toLowerCase().trim();
      if (normalized in groups) {
        groups[normalized].push(p);
        matched = true;
      }
    }
    if (!matched) {
      groups[OTHER_TAG_KEY].push(p);
    }
  }

  // Sort each bucket by contestId + index
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => {
      const idA = (a.contestId ?? 0) * 100 + a.index.charCodeAt(0);
      const idB = (b.contestId ?? 0) * 100 + b.index.charCodeAt(0);
      return idA - idB;
    });
  }

  // Remove empty buckets before saving (keeps tags.json clean)
  for (const key of Object.keys(groups)) {
    if (groups[key].length === 0) {
      delete groups[key];
    }
  }

  fs.writeFileSync(tagDbPath, JSON.stringify(groups, null, 2), 'utf-8');
  return groups;
}

/**
 * Returns tag keys in KNOWN_TAGS order, with "other" appended at the end.
 */
export function sortedTagKeys(groups: TagGroup): string[] {
  const ordered = KNOWN_TAGS.filter(t => t in groups) as string[];
  if (OTHER_TAG_KEY in groups) {
    ordered.push(OTHER_TAG_KEY);
  }
  return ordered;
}
