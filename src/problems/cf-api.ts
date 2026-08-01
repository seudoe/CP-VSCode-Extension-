import * as https from 'https';

export interface CFProblem {
  contestId?: number;
  problemsetName?: string;
  index: string;
  name: string;
  type: string;
  points?: number;
  rating?: number;
  tags: string[];
}

export interface CFContest {
  id: number;
  name: string;
  type: string;
  phase: 'BEFORE' | 'CODING' | 'FINISHED' | string;
  frozen: boolean;
  durationSeconds: number;
  startTimeSeconds?: number;
}

interface CFApiResponse {
  status: string;
  result: {
    problems: CFProblem[];
    problemStatistics: unknown[];
  };
}

interface CFContestListResponse {
  status: string;
  result: CFContest[];
}

/**
 * Fetches all problems from the Codeforces problemset API.
 * https://codeforces.com/apiHelp/methods#problemset.problems
 */
export function fetchAllProblems(): Promise<CFProblem[]> {
  return new Promise((resolve, reject) => {
    const url = 'https://codeforces.com/api/problemset.problems';

    https
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed: CFApiResponse = JSON.parse(raw);
            if (parsed.status !== 'OK') {
              reject(new Error(`CF API returned status: ${parsed.status}`));
              return;
            }
            resolve(parsed.result.problems);
          } catch (e) {
            reject(new Error(`Failed to parse CF API response: ${e}`));
          }
        });
      })
      .on('error', (err) => {
        reject(new Error(`CF API request failed: ${err.message}`));
      });
  });
}

/**
 * Fetches all contests from the Codeforces contest.list API.
 * https://codeforces.com/apiHelp/methods#contest.list
 */
export function fetchContests(): Promise<CFContest[]> {
  return new Promise((resolve, reject) => {
    // gym=false returns only regular contests, not gym problems
    const url = 'https://codeforces.com/api/contest.list?gym=false';

    https
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed: CFContestListResponse = JSON.parse(raw);
            if (parsed.status !== 'OK') {
              reject(new Error(`CF API returned status: ${parsed.status}`));
              return;
            }
            resolve(parsed.result);
          } catch (e) {
            reject(new Error(`Failed to parse CF contest list response: ${e}`));
          }
        });
      })
      .on('error', (err) => {
        reject(new Error(`CF contest.list request failed: ${err.message}`));
      });
  });
}
