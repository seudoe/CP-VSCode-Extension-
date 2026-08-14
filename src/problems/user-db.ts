import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export interface UserDetails {
  handle: string;
  problems: Record<string, string>;
  info?: any;
  rating?: any[];
}

let dbPath = '';

export function initUserDb(storagePath: string) {
  dbPath = path.join(storagePath, 'local-database', 'userDetails.json');
}

export function getUserDetails(): UserDetails | null {
  if (!dbPath) return null;
  try {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, 'utf8');
      return JSON.parse(data) as UserDetails;
    }
  } catch (err) {
    console.error('[seudoe/user-db] Failed to read user details', err);
  }
  return null;
}

export function saveUserDetails(details: UserDetails): void {
  if (!dbPath) return;
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(dbPath, JSON.stringify(details, null, 2), 'utf8');
  } catch (err) {
    console.error('[seudoe/user-db] Failed to save user details', err);
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status !== 'OK') {
            return reject(new Error(parsed.comment || `Failed to fetch from ${url}`));
          }
          resolve(parsed.result);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

export async function fetchUserStatus(handle: string): Promise<UserDetails> {
  const [statusResult, infoResult, ratingResult] = await Promise.all([
    fetchJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}`),
    fetchJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`),
    fetchJson(`https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`)
  ]);

  const problems = new Map<string, { wrong: number, accepted: boolean }>();
  const submissions = statusResult.slice().reverse();
  
  for (const sub of submissions) {
    const contestId = sub.problem?.contestId;
    const index = sub.problem?.index;
    if (contestId === undefined || index === undefined) continue;
    
    const id = `${contestId}${index}`;
    if (!problems.has(id)) {
      problems.set(id, { wrong: 0, accepted: false });
    }
    
    const p = problems.get(id)!;
    if (p.accepted) continue;
    
    const verdict = sub.verdict;
    if (verdict === 'OK') {
      p.accepted = true;
    } else if (verdict !== 'TESTING' && verdict !== 'COMPILATION_ERROR') {
      p.wrong++;
    }
  }

  const parsedProblems: Record<string, string> = {};
  for (const [id, p] of problems.entries()) {
    if (p.accepted) {
      parsedProblems[id] = p.wrong === 0 ? '+' : `+${p.wrong}`;
    } else if (p.wrong > 0) {
      parsedProblems[id] = `-${p.wrong}`;
    }
  }
  
  return { 
    handle, 
    problems: parsedProblems,
    info: infoResult[0],
    rating: ratingResult
  };
}
