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
import { CachedProblem } from './types';

// ── Load MONGODB_URI from .env.local ─────────────────────────────────────────

function loadMongoUri(): string {
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

async function getDb(): Promise<Db> {
  if (_db) { return _db; }

  const uri = loadMongoUri();
  _client = new MongoClient(uri, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  });

  await _client.connect();
  _db = _client.db('codeforces');
  console.log('[seudoe/db] Connected to MongoDB Atlas (codeforces)');
  return _db;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a problem statement from MongoDB.
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
 * Returns null if the image is not found.
 */
export async function fetchImage(filename: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const db = await getDb();
  const col = db.collection('images');

  const doc = await col.findOne({ filename });
  if (!doc) { return null; }

  const raw = doc['data'] as Binary | Buffer;
  const buffer = raw instanceof Binary ? Buffer.from(raw.buffer) : Buffer.from(raw);
  return { buffer, contentType: doc['contentType'] as string };
}

/**
 * Disconnect (call on extension deactivate).
 */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    console.log('[seudoe/db] MongoDB connection closed');
  }
}

/**
 * Report a problem error to MongoDB.
 */
export async function reportProblemError(contestId: number, index: string): Promise<void> {
  const db = await getDb();
  const col = db.collection('reports');
  const id = `${contestId}${index}`;

  await col.updateOne(
    { listed_for: 'report' },
    { $addToSet: { ids: id } },
    { upsert: true }
  );
  console.log(`[seudoe/db] Reported problem error for ${id}`);
}
