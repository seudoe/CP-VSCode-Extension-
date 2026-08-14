import * as vscode from 'vscode';
import { initDb, readDb, isUpToDate, refreshDb, ensureDerivedDbs } from './load-db';
import { readRatingDb, buildRatingDb, sortedRatingKeys, RatingGroup, RATING_RANK_LABEL, UNKNOWN_RATING_KEY } from './rating-db';
import { readTagDb, buildTagDb, sortedTagKeys, TagGroup, OTHER_TAG_KEY } from './tag-db';
import { readContestDb, ContestDB, ContestWithProblems } from './contest-db';
import { CFProblem } from './cf-api';
import { fetchProblem, fetchImage, closeDb, reportProblemError } from './db';
import { renderProblem } from './renderer';
import { getUserDetails, saveUserDetails, fetchUserStatus, UserDetails, initUserDb } from './user-db';

// ── CF rank color map ────────────────────────────────────────────────────────
// Source: https://gist.github.com/algon-320/4369c85b34cb4f76a7f843a5a803125b

function ratingToColor(ratingKey: string): string {
  if (ratingKey === UNKNOWN_RATING_KEY) { return '#888888'; }
  const r = Number(ratingKey);
  if (r < 1200) { return '#808080'; }
  if (r < 1400) { return '#008000'; }
  if (r < 1600) { return '#03A89E'; }
  if (r < 1900) { return '#0000FF'; }
  if (r < 2100) { return '#AA00AA'; }
  if (r < 2400) { return '#FF8C00'; }
  return '#FF0000';
}

const CF_RATING_SCHEME = 'cf-rating';

export class RatingDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CF_RATING_SCHEME) { return undefined; }
    const ratingKey = decodeURIComponent(uri.authority);
    const hex = ratingToColor(ratingKey);
    return {
      badge: RATING_RANK_LABEL[Number(ratingKey)] ?? '?',
      color: new vscode.ThemeColor(`charts.${hexToChartColor(hex)}`),
      tooltip: ratingKey === UNKNOWN_RATING_KEY ? 'No rating' : `Rating ${ratingKey}`,
    };
  }
}

function hexToChartColor(hex: string): string {
  switch (hex) {
    case '#008000': return 'green';
    case '#03A89E': return 'blue';
    case '#0000FF': return 'blue';
    case '#AA00AA': return 'purple';
    case '#FF8C00': return 'orange';
    case '#FF0000': return 'red';
    default:        return 'foreground';
  }
}

// ── Tree item types ──────────────────────────────────────────────────────────

const PROBLEM_CATEGORIES = [
  'All',
  'Rating',
  'Tag',
  'Favorite',
  'Past Contests',
  'Upcoming Contests',
  'CSES Problemset',
  'CP-31 Sheet',
  'A2OJ Ladders',
];

class ProblemCategoryItem extends vscode.TreeItem {
  constructor(public readonly category: string) {
    super(category, vscode.TreeItemCollapsibleState.Collapsed);
    if (category === 'All') {
      this.contextValue = 'problemCategoryAll';
    } else if (category === 'Past Contests') {
      this.contextValue = 'problemCategoryPast';
    } else {
      this.contextValue = 'problemCategory';
    }
  }
}

class RatingBucketItem extends vscode.TreeItem {
  constructor(public readonly ratingKey: string, count: number) {
    super(ratingKey, vscode.TreeItemCollapsibleState.Collapsed);
    const ratingNum = Number(ratingKey);
    this.description = ratingKey === UNKNOWN_RATING_KEY
      ? '?'
      : (RATING_RANK_LABEL[ratingNum] ?? '');
    this.tooltip = ratingKey === UNKNOWN_RATING_KEY
      ? `${count} problems with no rating`
      : `${count} problems rated ${ratingKey}`;
    this.contextValue = 'ratingBucket';
    this.resourceUri = vscode.Uri.parse(
      `${CF_RATING_SCHEME}://${encodeURIComponent(ratingKey)}`
    );
  }
}

class TagBucketItem extends vscode.TreeItem {
  constructor(public readonly tag: string, count: number) {
    const label = tag === OTHER_TAG_KEY
      ? 'Other'
      : tag.charAt(0).toUpperCase() + tag.slice(1);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${count}`;
    this.tooltip = `${count} problems tagged "${tag}"`;
    this.contextValue = 'tagBucket';
  }
}

class ContestItem extends vscode.TreeItem {
  constructor(public readonly entry: ContestWithProblems) {
    const { contest } = entry;
    // Label format: "[1234] Codeforces Round 1234 (Div. 2)"
    super(`[${contest.id}] ${contest.name}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${entry.problems.length} problems`;
    this.tooltip = entry.problems.length > 0
      ? `${entry.problems.length} problems`
      : 'No problems indexed yet';
    this.contextValue = 'contest';
  }
}

class ProblemItem extends vscode.TreeItem {
  constructor(public readonly problem: CFProblem, provider: ProblemsProvider) {
    const id = problem.contestId
      ? `${problem.contestId}${problem.index}`
      : problem.index;

    super(`[${id}] ${problem.name}`, vscode.TreeItemCollapsibleState.None);
    this.description = problem.rating ? `★ ${problem.rating}` : '';
    this.tooltip = problem.tags.length
      ? `Tags: ${problem.tags.join(', ')}`
      : 'No tags';
    this.contextValue = 'problem';

    const ratingKey = problem.rating ? String(problem.rating) : UNKNOWN_RATING_KEY;
    this.resourceUri = vscode.Uri.parse(
      `${CF_RATING_SCHEME}://${encodeURIComponent(ratingKey)}`
    );

    const userDetails = provider.getUserDetails();
    const statusStr = userDetails?.problems[id];

    if (statusStr) {
      this.iconPath = generateStatusIcon(statusStr, provider.getExtensionUri());
    } else {
      this.iconPath = vscode.Uri.joinPath(provider.getExtensionUri(), 'media', 'empty.svg');
    }

    // Fire the open command when clicked
    this.command = {
      command: 'seudoe.openProblem',
      title: 'Open Problem',
      arguments: [problem],
    };
  }
}

function generateStatusIcon(statusStr: string, extensionUri: vscode.Uri): vscode.Uri {
  const isPositive = statusStr.startsWith('+');
  const color = isPositive ? '#4fb56b' : '#f14c4c'; // Green or Red
  
  const fs = require('fs') as typeof import('fs');
  const safeName = statusStr.replace('+', 'plus_').replace('-', 'minus_') + '.svg';
  const folderPath = vscode.Uri.joinPath(extensionUri, 'media', 'status');
  const filePath = vscode.Uri.joinPath(folderPath, safeName);
  
  if (!fs.existsSync(folderPath.fsPath)) {
    fs.mkdirSync(folderPath.fsPath, { recursive: true });
  }

  if (!fs.existsSync(filePath.fsPath)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16">
      <text x="12" y="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="bold" fill="${color}" text-anchor="middle">${statusStr}</text>
    </svg>`;
    fs.writeFileSync(filePath.fsPath, svg, 'utf8');
  }

  return filePath;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a duration in seconds as "Xd Xh Xm" or "Starts in Xh Xm" etc. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) { return 'Starting soon'; }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (d > 0) { parts.push(`${d}d`); }
  if (h > 0) { parts.push(`${h}h`); }
  if (m > 0 || parts.length === 0) { parts.push(`${m}m`); }

  return `Starts in ${parts.join(' ')}`;
}

// ── Problems Provider ────────────────────────────────────────────────────────

export class ProblemsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private allProblems: CFProblem[] = [];
  private ratingGroups: RatingGroup = {};
  private tagGroups: TagGroup = {};
  private contestDb: ContestDB = { past: [], upcoming: [] };
  private userDetails: UserDetails | null = null;

  constructor(private context: vscode.ExtensionContext) {
    const db = readDb();
    this.allProblems = db.problems;
    this.ratingGroups = readRatingDb();
    this.tagGroups = readTagDb();
    this.contestDb = readContestDb();
    this.userDetails = getUserDetails();
  }

  getUserDetails() { return this.userDetails; }
  getExtensionUri() { return this.context.extensionUri; }

  setUserDetails(details: UserDetails) {
    this.userDetails = details;
    this._onDidChangeTreeData.fire();
  }

  getProblems(): CFProblem[] { return this.allProblems; }
  getContests(): ContestDB { return this.contestDb; }

  /** Called after ensureDerivedDbs() resolves on startup */
  setContestDb(db: ContestDB): void {
    this.contestDb = db;
    this._onDidChangeTreeData.fire();
  }

  /** Called after a fresh API fetch */
  refresh(problems: CFProblem[], contests: ContestDB): void {
    const changed = problems.length !== this.allProblems.length;
    this.allProblems = problems;
    this.ratingGroups = buildRatingDb(problems);
    this.tagGroups = buildTagDb(problems);
    this.contestDb = contests;
    if (changed) {
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    // Root — category list
    if (!element) {
      return PROBLEM_CATEGORIES.map(c => new ProblemCategoryItem(c));
    }

    // All
    if (element instanceof ProblemCategoryItem && element.category === 'All') {
      if (this.allProblems.length === 0) {
        const loading = new vscode.TreeItem('Loading problems...');
        loading.description = 'Fetching from Codeforces API';
        return [loading];
      }
      return this.allProblems.map(p => new ProblemItem(p, this));
    }

    // Rating — sorted rating buckets
    if (element instanceof ProblemCategoryItem && element.category === 'Rating') {
      const keys = sortedRatingKeys(this.ratingGroups);
      if (keys.length === 0) {
        return [new vscode.TreeItem('Loading...')];
      }
      return keys.map((k: string) => new RatingBucketItem(k, this.ratingGroups[k].length));
    }

    // Rating bucket — problems inside it
    if (element instanceof RatingBucketItem) {
      return (this.ratingGroups[element.ratingKey] ?? []).map((p: CFProblem) => new ProblemItem(p, this));
    }

    // Tag — sorted tag buckets
    if (element instanceof ProblemCategoryItem && element.category === 'Tag') {
      const keys = sortedTagKeys(this.tagGroups);
      if (keys.length === 0) {
        return [new vscode.TreeItem('Loading...')];
      }
      return keys.map((k: string) => new TagBucketItem(k, this.tagGroups[k].length));
    }

    // Tag bucket — problems inside it
    if (element instanceof TagBucketItem) {
      return (this.tagGroups[element.tag] ?? []).map((p: CFProblem) => new ProblemItem(p, this));
    }

    // Past Contests
    if (element instanceof ProblemCategoryItem && element.category === 'Past Contests') {
      if (this.contestDb.past.length === 0) {
        return [new vscode.TreeItem('Loading...')];
      }
      return this.contestDb.past.map((e: ContestWithProblems) => new ContestItem(e));
    }

    // Upcoming Contests
    if (element instanceof ProblemCategoryItem && element.category === 'Upcoming Contests') {
      if (this.contestDb.upcoming.length === 0) {
        const empty = new vscode.TreeItem('No upcoming contests');
        return [empty];
      }
      return this.contestDb.upcoming.map((e: ContestWithProblems) => new ContestItem(e));
    }

    // Contest — problems inside it
    if (element instanceof ContestItem) {
      const problems = element.entry.problems;
      if (problems.length === 0) {
        // For upcoming contests show time remaining instead of "no problems"
        const startTime = element.entry.contest.startTimeSeconds;
        if (startTime !== undefined) {
          const remaining = startTime - Math.floor(Date.now() / 1000);
          const countdown = new vscode.TreeItem(formatCountdown(remaining));
          return [countdown];
        }
        return [new vscode.TreeItem('No problems indexed')];
      }
      return problems.map((p: CFProblem) => new ProblemItem(p, this));
    }

    // Other categories — coming soon
    if (element instanceof ProblemCategoryItem) {
      return [new vscode.TreeItem('Coming soon')];
    }

    return [];
  }
}

// ── Webview panel manager ────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;
let currentMessageListener: vscode.Disposable | undefined;

export async function openProblemPanel(
  problem: CFProblem,
  context: vscode.ExtensionContext
): Promise<void> {
  const { contestId, index } = problem;
  if (!contestId) {
    vscode.window.showWarningMessage('This problem has no contest ID — cannot open.');
    return;
  }

  const id = `${contestId}${index}`;

  // Reuse existing panel or create a new one
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      'cfProblem',
      `[${id}] ${problem.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      }
    );
    currentPanel.onDidDispose(() => { currentPanel = undefined; });
  }

  // Update title
  currentPanel.title = `[${id}] ${problem.name}`;

  // Show loading state while fetching from MongoDB
  currentPanel.webview.html = loadingHtml(id, problem.name);

  // Handle messages from the webview
  if (currentMessageListener) {
    currentMessageListener.dispose();
  }

  currentMessageListener = currentPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'fetchImage') {
      try {
        const result = await fetchImage(msg.filename as string);
        if (result && currentPanel) {
          const base64 = result.buffer.toString('base64');
          currentPanel.webview.postMessage({
            type: 'imageData',
            filename: msg.filename,
            dataUri: `data:${result.contentType};base64,${base64}`,
          });
        }
      } catch (err) {
        console.error(`[seudoe] Failed to load image ${msg.filename}:`, err);
      }
    } else if (msg.type === 'reportError') {
      try {
        await reportProblemError(problem.contestId!, problem.index);
        vscode.window.showInformationMessage(`Reported problem ${problem.contestId}${problem.index} successfully!`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to report problem: ${err}`);
      }
    } else if (msg.type === 'openBrowser') {
      const url = `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });

  // Fetch problem from MongoDB
  try {
    const cached = await fetchProblem(contestId, index);
    if (!cached) {
      if (currentPanel) {
        currentPanel.webview.html = errorHtml(
          id,
          `Problem ${id} not found in database.\n\nServer or Database Error. The problem statement could not be fetched.`,
          problem.contestId,
          problem.index
        );
      }
      return;
    }
    if (currentPanel) {
      currentPanel.webview.html = renderProblem(cached, problem, currentPanel.webview, context.extensionUri);
    }
  } catch (err) {
    console.error(`[seudoe] MongoDB fetch failed for ${id}:`, err);
    if (currentPanel) {
      currentPanel.webview.html = errorHtml(id, String(err), problem.contestId, problem.index);
    }
  }
}

function loadingHtml(id: string, name: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;color:#ccc">
    <h2>[${id}] ${name}</h2>
    <p>Loading problem statement…</p>
  </body></html>`;
}

function errorHtml(id: string, msg: string, contestId?: number, index?: string): string {
  const browserBtn = contestId && index
    ? `<br><br><a href="https://codeforces.com/problemset/problem/${contestId}/${index}" style="color:#4e9eff;text-decoration:none;border:1px solid #4e9eff;padding:6px 12px;border-radius:4px;display:inline-block">See the problem statement in default browser</a>`
    : '';

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;color:#f44">
    <h2>Failed to load [${id}]</h2><pre>${msg}</pre>${browserBtn}
  </body></html>`;
}
