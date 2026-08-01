import * as fs from 'fs';
import * as path from 'path';
import { CFProblem } from './cf-api';

export type RatingGroup = Record<string, CFProblem[]>;

// CF rank labels shown as description in the sidebar (matches the screenshot)
export const RATING_RANK_LABEL: Record<number, string> = {
  800:  'NE',  // Newbie
  900:  'NE',
  1000: 'NE',
  1100: 'NE',
  1200: 'PU',  // Pupil
  1300: 'PU',
  1400: 'SP',  // Specialist
  1500: 'SP',
  1600: 'EX',  // Expert
  1700: 'EX',
  1800: 'EX',
  1900: 'CM',  // Candidate Master
  2000: 'CM',
  2100: 'MA',  // Master
  2200: 'MA',
  2300: 'MA',
  2400: 'GM',  // Grandmaster
  2500: 'GM',
  2600: 'GM',
  2700: 'IG',  // International Grandmaster
  2800: 'IG',
  2900: 'IG',
  3000: 'LG',  // Legendary Grandmaster
  3100: 'LG',
  3200: 'LG',
  3300: 'LG',
  3400: 'LG',
  3500: 'LG',
};

let ratingDbPath: string;

export function initRatingDb(storagePath: string): void {
  ratingDbPath = path.join(storagePath, 'local-database', 'ratings.json');
}

export function readRatingDb(): RatingGroup {
  try {
    const raw = fs.readFileSync(ratingDbPath, 'utf-8');
    return JSON.parse(raw) as RatingGroup;
  } catch {
    return {};
  }
}

export const UNKNOWN_RATING_KEY = 'Unknown';

/**
 * Groups problems by rating, writes ratings.json, and returns the grouped map.
 * Problems without a rating go into the "Unknown" bucket.
 */
export function buildRatingDb(problems: CFProblem[]): RatingGroup {
  const groups: RatingGroup = {};

  for (const p of problems) {
    const key = (p.rating === undefined || p.rating === null)
      ? UNKNOWN_RATING_KEY
      : String(p.rating);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(p);
  }

  // Sort each bucket by contestId + index so the list is stable
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => {
      const idA = (a.contestId ?? 0) * 100 + a.index.charCodeAt(0);
      const idB = (b.contestId ?? 0) * 100 + b.index.charCodeAt(0);
      return idA - idB;
    });
  }

  fs.writeFileSync(ratingDbPath, JSON.stringify(groups, null, 2), 'utf-8');
  return groups;
}

/** Sorted rating keys as numbers (ascending), with "Unknown" appended at the end */
export function sortedRatingKeys(groups: RatingGroup): string[] {
  const numeric = Object.keys(groups)
    .filter(k => k !== UNKNOWN_RATING_KEY)
    .map(Number)
    .sort((a, b) => a - b)
    .map(String);

  if (groups[UNKNOWN_RATING_KEY]) {
    numeric.push(UNKNOWN_RATING_KEY);
  }

  return numeric;
}
