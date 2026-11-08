/**
 * db.ts — Direct MongoDB Atlas connection for the seudoe VS Code extension.
 *
 * Reads MONGODB_URI from .env.local (next to package.json) and connects
 * directly to the Atlas cluster to fetch problem statements.
 *
 * Collections used (db: "codeforces"):
 *   problems       — CachedProblem documents
 *   problem_index  — single doc { ids: string[] } for fast ID lookup
 *   images         — { filename, contentType, data: Binary }
 */

import * as path from 'path';
import * as fs from 'fs';
import { MongoClient, Db, Binary } from 'mongodb';
import { CachedProblem, CsesProblemSummary, CachedCsesProblem } from './types';

// ── Load MONGODB_URI from .env.local ─────────────────────────────────────────

function loadMongoUri(): string {
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  // esbuild output is dist/extension.js, so extensionPath = dist/..
  // .env.local lives next to package.json, two levels up from dist/
  const candidates = [
    path.join(__dirname, '..', '.env.local'),      // dist/../.env.local  (dev F5)
    path.join(__dirname, '..', '..', '.env.local'), // fallback deeper path
    path.join(__dirname, '.env.local'),              // same dir (packaged)
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) { continue; }
        const eq = trimmed.indexOf('=');
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key === 'MONGODB_URI') { return val; }
      }
    }
  }

  // Fallback: process environment
  const envUri = process.env['MONGODB_URI'];
  if (envUri) { return envUri; }

  throw new Error(
    'MONGODB_URI not found. Add it to .env.local next to package.json:\n  MONGODB_URI=mongodb+srv://...'
  );
}

// ── Singleton connection ──────────────────────────────────────────────────────

let _client: MongoClient | null = null;
let _db: Db | null = null;
let _csesDb: Db | null = null;
let _csesProblemsCache: CsesProblemSummary[] | null = null;

async function getClient(): Promise<MongoClient> {
  if (_client) { return _client; }

  const uri = loadMongoUri();
  _client = new MongoClient(uri, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  });

  await _client.connect();
  return _client;
}

async function getDb(): Promise<Db> {
  if (_db) { return _db; }
  const client = await getClient();
  _db = client.db('codeforces');
  console.log('[seudoe/db] Connected to MongoDB Atlas (codeforces)');
  return _db;
}

async function getCsesDb(): Promise<Db> {
  if (_csesDb) { return _csesDb; }
  const client = await getClient();
  _csesDb = client.db('cses');
  console.log('[seudoe/db] Connected to MongoDB Atlas (cses)');
  return _csesDb;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a problem statement from MongoDB (Codeforces).
 * Returns null if not found.
 */
export async function fetchProblem(contestId: number, index: string): Promise<CachedProblem | null> {
  const db = await getDb();
  const col = db.collection('problems');

  const doc = await col.findOne(
    { contestId, index: index.toUpperCase() },
    { projection: { _id: 0 } }
  );

  return doc as CachedProblem | null;
}

/**
 * Fetch all CSES problems metadata from MongoDB (database: cses, collection: problems).
 * Returns array of CsesProblemSummary, sorted by taskId.
 */
export async function fetchCsesProblemsList(forceRefresh: boolean = false): Promise<CsesProblemSummary[]> {
  if (_csesProblemsCache && !forceRefresh) {
    return _csesProblemsCache;
  }

  try {
    const db = await getCsesDb();
    const col = db.collection('problems');
    const docs = await col.find(
      {},
      {
        projection: {
          _id: 0,
          id: 1,
          taskId: 1,
          name: 1,
          category: 1,
          solvedCount: 1,
          attemptCount: 1,
          url: 1,
        },
      }
    ).toArray();

    const problems: CsesProblemSummary[] = docs.map((d: any) => ({
      id: String(d.id || d.taskId),
      taskId: Number(d.taskId || d.id),
      name: String(d.name || ''),
      category: String(d.category || 'General'),
      solvedCount: d.solvedCount ?? null,
      attemptCount: d.attemptCount ?? null,
      url: d.url || `https://cses.fi/problemset/task/${d.id || d.taskId}`,
      isCses: true as const,
    }));

    problems.sort((a, b) => a.taskId - b.taskId);
    _csesProblemsCache = problems;
    return problems;
  } catch (err) {
    console.error('[seudoe/db] Failed to fetch CSES problems list:', err);
    return [];
  }
}

/**
 * Fetch a full CSES problem statement from MongoDB.
 * Returns null if not found.
 */
export async function fetchCsesProblem(taskId: string | number): Promise<CachedCsesProblem | null> {
  const db = await getCsesDb();
  const col = db.collection('problems');
  const idStr = String(taskId);
  const idNum = Number(taskId);

  const doc = await col.findOne(
    { $or: [{ id: idStr }, { taskId: idNum }] },
    { projection: { _id: 0 } }
  );

  return doc as CachedCsesProblem | null;
}

/**
 * Fetch the list of all scraped problem IDs from problem_index.
 * Returns empty array if collection is empty.
 */
export async function fetchScrapedIndex(): Promise<string[]> {
  try {
    const db = await getDb();
    const col = db.collection('problem_index');
    const doc = await col.findOne({});
    if (!doc) { return []; }
    return (doc['ids'] as string[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch a raw image buffer + content type from MongoDB.
 * Checks Codeforces images first, then CSES images.
 * Returns null if the image is not found.
 */
export async function fetchImage(filename: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  // 1. Try Codeforces images collection
  try {
    const db = await getDb();
    const col = db.collection('images');
    let doc = await col.findOne({ filename });

    // 2. Fallback to CSES images collection
    if (!doc) {
      const csesDb = await getCsesDb();
      doc = await csesDb.collection('images').findOne({ filename });
    }

    if (!doc) { return null; }

    const raw = doc['data'] as Binary | Buffer;
    const buffer = raw instanceof Binary ? Buffer.from(raw.buffer) : Buffer.from(raw);
    return { buffer, contentType: doc['contentType'] as string };
  } catch (err) {
    console.error(`[seudoe/db] fetchImage error for ${filename}:`, err);
    return null;
  }
}

/**
 * Disconnect (call on extension deactivate).
 */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _csesDb = null;
    _csesProblemsCache = null;
    console.log('[seudoe/db] MongoDB connection closed');
  }
}

/**
 * Report a problem error to MongoDB.
 */
export async function reportProblemError(contestId: number, index: string, reason: string, customReason?: string): Promise<void> {
  const db = await getDb();
  const col = db.collection('reports');
  const id = `${contestId}${index}`;

  if (reason.toLowerCase() === 'other' && customReason) {
    await col.updateOne(
      { report_reason: reason },
      { $addToSet: { ids: { id, reason: customReason } } },
      { upsert: true }
    );
  } else {
    await col.updateOne(
      { report_reason: reason },
      { $addToSet: { ids: id } },
      { upsert: true }
    );
  }
  
  console.log(`[seudoe/db] Reported problem error for ${id} with reason: ${reason}`);
}
