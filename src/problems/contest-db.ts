import * as fs from 'fs';
import * as path from 'path';
import { CFContest, CFProblem, fetchContests } from './cf-api';

export interface ContestWithProblems {
  contest: CFContest;
  problems: CFProblem[];
}

export interface ContestDB {
  past: ContestWithProblems[];
  upcoming: ContestWithProblems[];
}

let contestDbPath: string;

export function initContestDb(storagePath: string): void {
  contestDbPath = path.join(storagePath, 'local-database', 'contests.json');
}

export function readContestDb(): ContestDB {
  try {
    const raw = fs.readFileSync(contestDbPath, 'utf-8');
    return JSON.parse(raw) as ContestDB;
  } catch {
    return { past: [], upcoming: [] };
  }
}

function writeContestDb(db: ContestDB): void {
  fs.writeFileSync(contestDbPath, JSON.stringify(db, null, 2), 'utf-8');
}

/**
 * Fetches contest list from CF API, filters past/upcoming,
 * joins problems from all.json by contestId, writes contests.json.
 */
export async function buildContestDb(allProblems: CFProblem[]): Promise<ContestDB> {
  const contests = await fetchContests();

  // Index problems by contestId for fast lookup
  const problemsByContest = new Map<number, CFProblem[]>();
  for (const p of allProblems) {
    if (p.contestId === undefined) { continue; }
    if (!problemsByContest.has(p.contestId)) {
      problemsByContest.set(p.contestId, []);
    }
    problemsByContest.get(p.contestId)!.push(p);
  }

  // Sort problems inside each contest by index letter (A, B, C, ...)
  for (const [, probs] of problemsByContest) {
    probs.sort((a, b) => a.index.localeCompare(b.index));
  }

  const past: ContestWithProblems[] = [];
  const upcoming: ContestWithProblems[] = [];

  for (const contest of contests) {
    const entry: ContestWithProblems = {
      contest,
      problems: problemsByContest.get(contest.id) ?? [],
    };

    if (contest.phase === 'FINISHED') {
      past.push(entry);
    } else {
      // BEFORE or CODING
      upcoming.push(entry);
    }
  }

  // Past contests: most recent first (highest id first)
  past.sort((a, b) => b.contest.id - a.contest.id);

  // Upcoming contests: soonest first (lowest startTimeSeconds first)
  upcoming.sort((a, b) => {
    const tA = a.contest.startTimeSeconds ?? Infinity;
    const tB = b.contest.startTimeSeconds ?? Infinity;
    return tA - tB;
  });

  const db: ContestDB = { past, upcoming };
  writeContestDb(db);
  return db;
}

/**
 * Rebuilds contests.json from existing all.json + fresh API call.
 * Used on startup when problems DB is already up to date.
 */
export async function ensureContestDb(allProblems: CFProblem[]): Promise<ContestDB> {
  // If contests.json already exists and has data, use it — no re-fetch needed
  const existing = readContestDb();
  if (existing.past.length > 0 || existing.upcoming.length > 0) {
    return existing;
  }
  // Otherwise fetch fresh
  return buildContestDb(allProblems);
}
