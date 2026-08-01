import * as fs from 'fs';
import * as path from 'path';
import { CFProblem, fetchAllProblems } from './cf-api';
import { initRatingDb, buildRatingDb } from './rating-db';
import { initTagDb, buildTagDb } from './tag-db';
import { initContestDb, buildContestDb, ensureContestDb, ContestDB } from './contest-db';

export interface ProblemDB {
  lastUpdated: string | null;
  problems: CFProblem[];
}

let dbPath: string;

export function initDb(storagePath: string): void {
  const dir = path.join(storagePath, 'local-database');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dbPath = path.join(dir, 'all.json');
  initRatingDb(storagePath);
  initTagDb(storagePath);
  initContestDb(storagePath);

  if (!fs.existsSync(dbPath)) {
    writeDb({ lastUpdated: null, problems: [] });
  }
}

export function readDb(): ProblemDB {
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    return JSON.parse(raw) as ProblemDB;
  } catch {
    return { lastUpdated: null, problems: [] };
  }
}

function writeDb(db: ProblemDB): void {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isUpToDate(): boolean {
  const db = readDb();
  return db.lastUpdated === todayStr();
}

/**
 * Fetches fresh problems from CF API, saves all.json,
 * then rebuilds ratings.json, tags.json, and contests.json.
 * Returns problems + contest DB so the UI can refresh immediately.
 */
export async function refreshDb(): Promise<{ problems: CFProblem[]; contests: ContestDB }> {
  const problems = await fetchAllProblems();

  writeDb({ lastUpdated: todayStr(), problems });
  buildRatingDb(problems);
  buildTagDb(problems);
  // Contest fetch runs in parallel with the above (they're synchronous writes anyway)
  const contests = await buildContestDb(problems);

  return { problems, contests };
}

/**
 * Rebuilds derived DBs from existing all.json.
 * Contests are fetched fresh only if contests.json is missing/empty.
 */
export async function ensureDerivedDbs(): Promise<ContestDB> {
  const db = readDb();
  if (db.problems.length > 0) {
    buildRatingDb(db.problems);
    buildTagDb(db.problems);
    return ensureContestDb(db.problems);
  }
  return { past: [], upcoming: [] };
}
