import * as vscode from 'vscode';
import { CFProblem } from './cf-api';
import { CsesProblemSummary } from './types';
import { ProblemsProvider, openProblemPanel, openCsesProblemPanel } from './problems-view';
import { fetchUserStatus, saveUserDetails, getUserDetails } from './user-db';
import { sortedRatingKeys, RATING_RANK_LABEL, UNKNOWN_RATING_KEY } from './rating-db';
import { sortedTagKeys, OTHER_TAG_KEY } from './tag-db';

export class ProblemsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'seudoe.problemsView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly problemsStore: ProblemsProvider
  ) {
    // Listen to store updates (CF API sync, CSES sync, User status sync)
    this.problemsStore.onDidChangeTreeData(() => {
      this._contestMap = undefined;
      this.sendMetadata();
    });

    // Listen to VS Code setting changes (two-way sync)
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('seuCF')) {
          this.sendSettings();
        }
      })
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleWebviewMessage(message);
    });

    this.sendMetadata();
    this.sendSettings();
  }

  private async handleWebviewMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.sendMetadata();
        this.sendSettings();
        break;
      }
      case 'loadBucket': {
        this.handleLoadBucket(msg);
        break;
      }
      case 'openProblem': {
        const p = msg.problem as CFProblem;
        if (p) {
          openProblemPanel(p, this.context);
        }
        break;
      }
      case 'openCsesProblem': {
        const p = msg.problem as CsesProblemSummary;
        if (p) {
          openCsesProblemPanel(p, this.context);
        }
        break;
      }
      case 'updateSetting': {
        const { key, value } = msg;
        if (!key) { return; }
        const bareKey = key.startsWith('seuCF.') ? key.substring(6) : key;
        const config = vscode.workspace.getConfiguration('seuCF');
        try {
          await config.update(bareKey, value, vscode.ConfigurationTarget.Global);
          
          if (bareKey === 'codeforcesUsername' && typeof value === 'string' && value.trim()) {
            await this.syncUserSubmissions(value.trim());
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to update setting ${key}: ${err?.message || err}`);
        }
        break;
      }
      case 'syncUserHandle': {
        const handle = msg.handle;
        if (handle) {
          await this.syncUserSubmissions(handle);
        }
        break;
      }
      case 'browseDirectory': {
        const uri = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: 'Select File Creation Directory'
        });
        if (uri && uri[0]) {
          const selectedPath = uri[0].fsPath;
          const key = msg.key;
          const bareKey = key.startsWith('seuCF.') ? key.substring(6) : key;
          await vscode.workspace.getConfiguration('seuCF').update(bareKey, selectedPath, vscode.ConfigurationTarget.Global);
          this.sendSettings();
        }
        break;
      }
      case 'browseFile': {
        const uri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: msg.title || 'Select Cookie File'
        });
        if (uri && uri[0]) {
          const selectedPath = uri[0].fsPath;
          const key = msg.key;
          const bareKey = key.startsWith('seuCF.') ? key.substring(6) : key;
          await vscode.workspace.getConfiguration('seuCF').update(bareKey, selectedPath, vscode.ConfigurationTarget.Global);
          this.sendSettings();
        }
        break;
      }
    }
  }

  private _contestMap?: Map<number, string>;
  private getContestName(contestId?: number): string {
    if (!contestId) { return ''; }
    if (!this._contestMap) {
      this._contestMap = new Map();
      const contestDb = this.problemsStore.getContests();
      for (const c of contestDb.past) {
        this._contestMap.set(c.contest.id, c.contest.name);
      }
      for (const c of contestDb.upcoming) {
        this._contestMap.set(c.contest.id, c.contest.name);
      }
    }
    return this._contestMap.get(contestId) || `Contest ${contestId}`;
  }

  private sortProblems(problems: CFProblem[], sort?: string): CFProblem[] {
    if (!sort || sort === 'default') {
      return problems;
    }
    const copy = [...problems];
    switch (sort) {
      case 'name':
      case 'name_asc':
        return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      case 'name_desc':
        return copy.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));

      case 'contest_num':
      case 'contest_num_asc':
        return copy.sort((a, b) => {
          const cA = a.contestId ?? 0;
          const cB = b.contestId ?? 0;
          if (cA !== cB) { return cA - cB; }
          return a.index.localeCompare(b.index, undefined, { numeric: true });
        });
      case 'contest_num_desc':
        return copy.sort((a, b) => {
          const cA = a.contestId ?? 0;
          const cB = b.contestId ?? 0;
          if (cA !== cB) { return cB - cA; }
          return a.index.localeCompare(b.index, undefined, { numeric: true });
        });

      case 'contest':
      case 'contest_asc':
        return copy.sort((a, b) => {
          const nameA = this.getContestName(a.contestId);
          const nameB = this.getContestName(b.contestId);
          const cmp = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
          if (cmp !== 0) { return cmp; }
          return a.index.localeCompare(b.index, undefined, { numeric: true });
        });
      case 'contest_desc':
        return copy.sort((a, b) => {
          const nameA = this.getContestName(a.contestId);
          const nameB = this.getContestName(b.contestId);
          const cmp = nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
          if (cmp !== 0) { return cmp; }
          return a.index.localeCompare(b.index, undefined, { numeric: true });
        });

      case 'rating_asc':
        return copy.sort((a, b) => {
          const rA = (a.rating !== undefined && a.rating !== null && a.rating > 0) ? a.rating : 999999;
          const rB = (b.rating !== undefined && b.rating !== null && b.rating > 0) ? b.rating : 999999;
          if (rA !== rB) { return rA - rB; }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'rating':
      case 'rating_desc':
        return copy.sort((a, b) => {
          const rA = (a.rating !== undefined && a.rating !== null && a.rating > 0) ? a.rating : -1;
          const rB = (b.rating !== undefined && b.rating !== null && b.rating > 0) ? b.rating : -1;
          if (rA !== rB) { return rB - rA; }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

      case 'tags':
      case 'tags_asc':
        return copy.sort((a, b) => {
          const tA = (a.tags && a.tags.length > 0) ? a.tags.join(', ') : 'zzz';
          const tB = (b.tags && b.tags.length > 0) ? b.tags.join(', ') : 'zzz';
          const cmp = tA.localeCompare(tB, undefined, { sensitivity: 'base' });
          if (cmp !== 0) { return cmp; }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'tags_desc':
        return copy.sort((a, b) => {
          const tA = (a.tags && a.tags.length > 0) ? a.tags.join(', ') : '';
          const tB = (b.tags && b.tags.length > 0) ? b.tags.join(', ') : '';
          const cmp = tB.localeCompare(tA, undefined, { sensitivity: 'base' });
          if (cmp !== 0) { return cmp; }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

      default:
        return copy;
    }
  }

  private sortCsesProblems(problems: CsesProblemSummary[], sort?: string): CsesProblemSummary[] {
    const copy = [...problems];
    switch (sort) {
      case 'name':
      case 'name_asc':
        return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      case 'name_desc':
        return copy.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));
      case 'default':
      default:
        return copy.sort((a, b) => (a.taskId || 0) - (b.taskId || 0));
    }
  }

  /** On-demand problem fetcher (lightweight IPC, avoids memory spikes) */
  private handleLoadBucket(msg: { bucketType: string; key?: string; offset?: number; limit?: number; sort?: string }) {
    if (!this._view) { return; }
    const { bucketType, key, offset = 0, limit = 50, sort } = msg;

    if (bucketType === 'all') {
      let all = this.problemsStore.getProblems();
      if (sort && sort !== 'default') {
        all = this.sortProblems(all, sort);
      }
      const slice = all.slice(offset, offset + limit).map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating,
        tags: p.tags || [],
        contestName: this.getContestName(p.contestId)
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key: 'all',
        offset,
        problems: slice,
        hasMore: offset + limit < all.length,
        total: all.length,
        sort
      });
    } else if (bucketType === 'rating' && key) {
      const groups = this.problemsStore.getRatingGroups();
      let list = groups[key] || [];
      if (sort && sort !== 'default') {
        list = this.sortProblems(list, sort);
      }
      const problems = list.map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating,
        tags: p.tags || [],
        contestName: this.getContestName(p.contestId)
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems,
        sort
      });
    } else if (bucketType === 'tag' && key) {
      const groups = this.problemsStore.getTagGroups();
      let list = groups[key] || [];
      if (sort && sort !== 'default') {
        list = this.sortProblems(list, sort);
      }
      const problems = list.map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating,
        tags: p.tags || [],
        contestName: this.getContestName(p.contestId)
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems,
        sort
      });
    } else if (bucketType === 'contest' && key) {
      const past = this.problemsStore.getContests().past;
      const contest = past.find(c => String(c.contest.id) === String(key));
      let list = contest?.problems || [];
      if (sort && sort !== 'default') {
        list = this.sortProblems(list, sort);
      }
      const problems = list.map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating,
        tags: p.tags || [],
        contestName: contest?.contest.name || ''
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems,
        sort
      });
    } else if (bucketType === 'cses') {
      let list = this.problemsStore.getCsesProblems();
      if (sort && sort !== 'default') {
        list = this.sortCsesProblems(list, sort);
      }
      const slice = list.slice(offset, offset + limit).map(p => ({
        id: p.id,
        taskId: p.taskId,
        name: p.name,
        category: p.category,
        url: p.url,
        solvedCount: p.solvedCount,
        isCses: true as const
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key: 'cses',
        offset,
        problems: slice,
        hasMore: offset + limit < list.length,
        total: list.length,
        sort
      });
    } else if (bucketType === 'csesCat' && key) {
      const map = this.problemsStore.getCsesCategoryGroups();
      let list = map.get(key) || [];
      if (sort && sort !== 'default') {
        list = this.sortCsesProblems(list, sort);
      }
      const problems = list.map(p => ({
        id: p.id,
        taskId: p.taskId,
        name: p.name,
        category: p.category,
        url: p.url,
        solvedCount: p.solvedCount,
        isCses: true as const
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems,
        sort
      });
    }
  }

  public async syncUserSubmissions(handle: string): Promise<void> {
    try {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Fetching Codeforces submissions for ${handle}...`,
        cancellable: false
      }, async () => {
        const details = await fetchUserStatus(handle);
        saveUserDetails(details);
        this.problemsStore.setUserDetails(details);
        this.sendMetadata();
        this.sendSettings();
        vscode.window.showInformationMessage(`Successfully loaded submission status for ${handle}!`);
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to fetch user submissions: ${err.message}`);
    }
  }

  private _metadataTimer?: NodeJS.Timeout;

  /** Sends only lightweight category metadata (~9 KB instead of 25 MB) */
  public sendMetadata(): void {
    if (!this._view) { return; }
    if (this._metadataTimer) {
      clearTimeout(this._metadataTimer);
    }
    this._metadataTimer = setTimeout(() => {
      this._doSendMetadata();
    }, 50);
  }

  private _doSendMetadata(): void {
    if (!this._view) { return; }

    const allProblems = this.problemsStore.getProblems();
    const ratingGroups = this.problemsStore.getRatingGroups();
    const tagGroups = this.problemsStore.getTagGroups();
    const contestDb = this.problemsStore.getContests();
    const csesProblems = this.problemsStore.getCsesProblems();
    const userDetails = this.problemsStore.getUserDetails();

    const ratingKeys = sortedRatingKeys(ratingGroups);
    const tagKeys = sortedTagKeys(tagGroups);

    const csesCatMap = this.problemsStore.getCsesCategoryGroups();
    const csesCategories = Array.from(csesCatMap.entries()).map(([cat, list]) => ({
      category: cat,
      count: list.length
    }));

    this._view.webview.postMessage({
      type: 'metadata',
      payload: {
        allCount: allProblems.length,
        ratings: ratingKeys.map(k => {
          const ratingNum = Number(k);
          const desc = k === UNKNOWN_RATING_KEY ? '?' : (RATING_RANK_LABEL[ratingNum] ?? '');
          return {
            rating: k,
            description: desc,
            count: (ratingGroups[k] || []).length
          };
        }),
        tags: tagKeys.map(k => {
          const label = k === OTHER_TAG_KEY ? 'Other' : k.charAt(0).toUpperCase() + k.slice(1);
          return {
            tag: label,
            rawTag: k,
            count: (tagGroups[k] || []).length
          };
        }),
        pastContests: contestDb.past.slice(0, 150).map(c => ({
          id: c.contest.id,
          name: c.contest.name,
          count: c.problems.length
        })),
        upcomingContests: contestDb.upcoming.map(c => ({
          id: c.contest.id,
          name: c.contest.name,
          startTimeSeconds: c.contest.startTimeSeconds,
          count: c.problems.length
        })),
        csesCount: csesProblems.length,
        csesCategories,
        userProblems: userDetails?.problems || {}
      }
    });
  }

  public sendSettings(): void {
    if (!this._view) { return; }

    const config = vscode.workspace.getConfiguration('seuCF');
    const userDetails = getUserDetails();

    const payload = {
      defaultFileExtension: config.get<string>('defaultFileExtension') || 'Select everytime',
      compilers: config.get<Record<string, string>>('compilers') || {},
      boilerplateCodes: config.get<Record<string, any>>('boilerplateCodes') || {},
      codeforcesFileName: config.get<string>('codeforcesFileName') || config.get<string>('fileName') || '{problemId}-{problemName}{fileExtension}',
      codeforcesFileCreationDirectory: config.get<string>('codeforcesFileCreationDirectory') || config.get<string>('fileCreationDirectory') || '',
      codeforcesUsername: config.get<string>('codeforcesUsername') || userDetails?.handle || '',
      codeforcesCookiePath: config.get<string>('codeforcesCookiePath') || '',
      csesFileName: config.get<string>('csesFileName') || '{problemId}-{problemName}{fileExtension}',
      csesFileCreationDirectory: config.get<string>('csesFileCreationDirectory') || '',
      csesUsername: config.get<string>('csesUsername') || '',
      csesCookiePath: config.get<string>('csesCookiePath') || '',
      userDetails: userDetails ? {
        handle: userDetails.handle,
        rating: userDetails.info?.rating || (userDetails.rating && userDetails.rating.length > 0 ? userDetails.rating[userDetails.rating.length - 1].newRating : undefined),
        rank: userDetails.info?.rank || '',
        solvedCount: Object.values(userDetails.problems || {}).filter(s => s && s.startsWith('+')).length,
        totalAttempted: Object.keys(userDetails.problems || {}).length,
      } : null
    };

    this._view.webview.postMessage({
      type: 'settingsData',
      payload
    });
  }

  private getHtmlForWebview(): string {
    const renderTopSortDropdown = (id: string, isRatingSection: boolean = false, isCses: boolean = false) => {
      if (isCses) {
        return `
        <select class="sort-select" id="sort_${id}" data-sub-id="${id}" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" onchange="handleSortSelectChange(this)">
          <option value="default">Sort ▾</option>
          <option value="name_asc">PS-Name (Asc) ▾</option>
          <option value="name_desc">PS-Name (Desc) ▾</option>
        </select>`;
      }
      return `
        <select class="sort-select" id="sort_${id}" data-sub-id="${id}" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" onchange="handleSortSelectChange(this)">
          <option value="default">Sort ▾</option>
          <option value="name_asc">PS-Name (Asc) ▾</option>
          <option value="name_desc">PS-Name (Desc) ▾</option>
          <option value="contest_num_asc">Contest-Number (Asc) ▾</option>
          <option value="contest_num_desc">Contest-Number (Desc) ▾</option>
          <option value="contest_asc">Contest-Name (Asc) ▾</option>
          <option value="contest_desc">Contest-Name (Desc) ▾</option>${!isRatingSection ? `
          <option value="rating_asc">Rating (Asc) ▾</option>
          <option value="rating_desc">Rating (Desc) ▾</option>` : ''}
          <option value="tags_asc">Tags (Asc) ▾</option>
          <option value="tags_desc">Tags (Desc) ▾</option>
        </select>`;
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Problems & Settings</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, #181818);
      padding: 0;
      overflow-x: hidden;
      user-select: none;
    }

    /* Tabs Bar at Top: flex: 1 so each tab takes exactly 50% width! */
    .tab-bar {
      display: flex;
      width: 100%;
      border-bottom: 1px solid var(--vscode-panel-border, #333333);
      background: var(--vscode-sideBar-background, #181818);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .tab-btn {
      flex: 1; /* 50% each for 2 tabs, 33.3% for 3, etc. */
      display: flex;
      align-items: center;
      justify-content: center;
      height: 38px;
      background: transparent;
      border: none;
      border-right: 1px solid var(--vscode-panel-border, #333333);
      cursor: pointer;
      color: var(--vscode-foreground, #888888);
      transition: all 0.15s ease;
      padding: 0;
    }
    .tab-btn:last-child {
      border-right: none;
    }
    .tab-btn.active {
      background: #0f3d64; /* Highlighted blue */
      color: #ffffff;
      box-shadow: inset 0 0 0 1px #1f85de;
    }
    .tab-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Tab Panels */
    .tab-panel {
      display: none;
    }
    .tab-panel.active {
      display: block;
    }

    /* ─── EXACT NATIVE VS CODE TREE VIEW STYLING ─── */
    .tree-container {
      padding: 2px 0 16px 0;
    }

    .tree-row {
      display: flex;
      align-items: center;
      height: 22px;
      line-height: 22px;
      padding-right: 8px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
    }
    .tree-row:hover {
      background-color: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.07));
    }

    /* Twistie Arrow */
    .twistie {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 22px;
      flex-shrink: 0;
      color: var(--vscode-foreground, #cccccc);
      opacity: 0.8;
      font-size: 9px;
    }
    .twistie svg {
      transition: transform 0.1s ease;
    }
    .twistie.expanded svg {
      transform: rotate(90deg);
    }
    .twistie.leaf {
      display: none;
    }

    /* Category Badges (CF, CSES, CP) */
    .badge-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 15px;
      border-radius: 3px;
      font-size: 9.5px;
      font-weight: bold;
      color: #ffffff;
      padding: 0 4px;
      margin-right: 6px;
      flex-shrink: 0;
      line-height: 1;
    }
    .badge-cf {
      background-color: #1f85de;
    }
    .badge-cses {
      background-color: #10b981;
    }
    .badge-other {
      background-color: #6b7280;
    }

    /* Folder Icon for buckets */
    .folder-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-right: 6px;
      flex-shrink: 0;
      color: var(--vscode-foreground, #cccccc);
      opacity: 0.8;
    }

    /* Status Badge for problems (+1, -1) */
    .status-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-right: 5px;
      flex-shrink: 0;
      font-size: 10px;
      font-weight: bold;
      line-height: 1;
    }
    .status-pos {
      color: #4fb56b;
    }
    .status-neg {
      color: #f14c4c;
    }

    /* Tree Label & Description */
    .tree-label {
      font-size: 13px;
      color: var(--vscode-foreground, #cccccc);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 1;
      min-width: 0;
    }
    .sort-select {
      border: none !important;
      outline: none !important;
      background: transparent !important;
      background-color: transparent !important;
      color: var(--vscode-descriptionForeground, #999999);
      font-family: inherit;
      font-size: 11px;
      height: 20px;
      line-height: 20px;
      padding: 0 !important;
      margin: 0 0 0 6px;
      cursor: pointer;
      box-shadow: none !important;
      appearance: none;
      -webkit-appearance: none;
      field-sizing: content;
      width: auto;
      vertical-align: middle;
      display: inline-block;
      flex-shrink: 0;
    }
    .sort-select:hover {
      color: var(--vscode-foreground, #ffffff);
    }
    .sort-select:focus {
      outline: none !important;
      color: var(--vscode-foreground, #ffffff);
    }
    .sort-select option {
      background-color: var(--vscode-dropdown-background, #252526);
      color: var(--vscode-dropdown-foreground, #cccccc);
      padding: 4px 8px;
    }
    .tree-description {
      font-size: 12px;
      margin-left: 6px;
      color: var(--vscode-descriptionForeground, #999999);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.85;
      flex-shrink: 1;
      min-width: 0;
    }
    .rank-badge {
      font-size: 9px;
      font-weight: bold;
      border: 1px solid currentColor;
      border-radius: 2px;
      padding: 0 3px;
      margin-left: 6px;
      line-height: 12px;
      height: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .tree-count {
      margin-left: auto;
      padding-right: 8px;
      font-size: 11px;
      opacity: 0.6;
      color: var(--vscode-descriptionForeground, #888888);
      flex-shrink: 0;
    }

    /* Uniform Indent Levels: child = 1 indent (16px), grandchild = 2 indent (28px) */
    .indent-0 { padding-left: 4px; }
    .indent-1 { padding-left: 16px; }
    .indent-2 { padding-left: 28px; }

    /* Children container */
    .tree-children {
      display: none;
    }
    .tree-children.open {
      display: block;
    }

    .load-more-row {
      padding-left: 37px;
      height: 22px;
      line-height: 22px;
      color: #1f85de;
      font-size: 12px;
      cursor: pointer;
    }
    .load-more-row:hover {
      text-decoration: underline;
    }

    /* ─── SETTINGS VIEW (CARD SECTIONS) ─── */
    .settings-container {
      padding: 10px 10px 30px 10px;
    }
    .settings-card {
      border: 1px solid var(--vscode-panel-border, #444444);
      border-radius: 5px;
      margin-bottom: 14px;
      background: var(--vscode-sideBar-background, #181818);
      overflow: hidden;
    }
    .card-header {
      padding: 10px 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground, #ffffff);
      border-bottom: 1px solid var(--vscode-panel-border, #333333);
      background: rgba(255, 255, 255, 0.02);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-body {
      padding: 12px;
    }
    .setting-group {
      margin-bottom: 14px;
    }
    .setting-group:last-child {
      margin-bottom: 0;
    }
    .setting-label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 5px;
      color: var(--vscode-foreground, #cccccc);
    }
    .setting-hint {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #888888);
      margin-top: 4px;
    }
    .input-row {
      display: flex;
      gap: 6px;
    }
    .text-input, .select-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }
    .text-input:focus, .select-input:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .btn {
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11.5px;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .user-status-badge {
      font-size: 11px;
      margin-top: 5px;
      color: #4fb56b;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .compilers-table {
      width: 100%;
      font-size: 11.5px;
      border-collapse: collapse;
      margin-top: 6px;
    }
    .compilers-table td {
      padding: 4px 0;
    }
    .compilers-table input {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 3px;
      font-size: 11.5px;
    }
  </style>
</head>
<body>

  <!-- Top Tab Bar: 2 tabs taking 50% width each! -->
  <div class="tab-bar">
    <!-- Tab 0: Problems View (Book Icon) -->
    <button class="tab-btn active" id="tabBtn0" title="Problems">
      <div class="tab-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <rect x="4" y="3" width="16" height="18" rx="2" fill="#803838" stroke="#a04848" stroke-width="1.5"/>
          <rect x="5.5" y="4.5" width="2" height="15" rx="0.5" fill="#582424"/>
          <line x1="10" y1="7" x2="17" y2="7" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="10" y1="11" x2="17" y2="11" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="10" y1="15" x2="14" y2="15" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
    </button>

    <!-- Tab 1: Settings View (Gear Icon) -->
    <button class="tab-btn" id="tabBtn1" title="Settings">
      <div class="tab-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </div>
    </button>
  </div>

  <!-- TAB PANEL 0: PROBLEMS VIEW (EXACT NATIVE VS CODE LOOK) -->
  <div class="tab-panel active" id="panelProblems">
    <div class="tree-container" id="treeContainer">
      <!-- 1. All (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('all')">
        <span class="twistie" id="tw_all"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">All</span>
        ${renderTopSortDropdown('all')}
      </div>
      <div class="tree-children" id="ch_all"></div>

      <!-- 2. Rating (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('rating')">
        <span class="twistie" id="tw_rating"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Rating</span>
        ${renderTopSortDropdown('rating', true)}
      </div>
      <div class="tree-children" id="ch_rating"></div>

      <!-- 3. Tag (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('tag')">
        <span class="twistie" id="tw_tag"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Tag</span>
        ${renderTopSortDropdown('tag')}
      </div>
      <div class="tree-children" id="ch_tag"></div>

      <!-- 4. Favorite (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('favorite')">
        <span class="twistie" id="tw_favorite"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Favorite</span>
        ${renderTopSortDropdown('favorite')}
      </div>
      <div class="tree-children" id="ch_favorite">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">No favorites</span></div>
      </div>

      <!-- 5. Past Contests (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('past')">
        <span class="twistie" id="tw_past"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Past Contests</span>
        ${renderTopSortDropdown('past')}
      </div>
      <div class="tree-children" id="ch_past"></div>

      <!-- 6. Upcoming Contests (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('upcoming')">
        <span class="twistie" id="tw_upcoming"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Upcoming Contests</span>
        ${renderTopSortDropdown('upcoming')}
      </div>
      <div class="tree-children" id="ch_upcoming"></div>

      <!-- 7. CSES Problemset (CSES) -->
      <div class="tree-row indent-0" onclick="toggleNode('cses-all')">
        <span class="twistie" id="tw_cses-all"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cses">CSES</span>
        <span class="tree-label">CSES Problemset</span>
        ${renderTopSortDropdown('cses-all', false, true)}
      </div>
      <div class="tree-children" id="ch_cses-all"></div>

      <!-- 8. CSES Categories (CSES) -->
      <div class="tree-row indent-0" onclick="toggleNode('cses-cat')">
        <span class="twistie" id="tw_cses-cat"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cses">CSES</span>
        <span class="tree-label">CSES Categories</span>
        ${renderTopSortDropdown('cses-cat', false, true)}
      </div>
      <div class="tree-children" id="ch_cses-cat"></div>

      <!-- 9. CP-31 Sheet (Future) -->
      <div class="tree-row indent-0" onclick="toggleNode('cp31')">
        <span class="twistie" id="tw_cp31"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-other">CP</span>
        <span class="tree-label">CP-31 Sheet</span>
        ${renderTopSortDropdown('cp31')}
      </div>
      <div class="tree-children" id="ch_cp31">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">Coming soon</span></div>
      </div>

      <!-- 10. A2OJ Ladders (Future) -->
      <div class="tree-row indent-0" onclick="toggleNode('a2oj')">
        <span class="twistie" id="tw_a2oj"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-other">CP</span>
        <span class="tree-label">A2OJ Ladders</span>
        ${renderTopSortDropdown('a2oj')}
      </div>
      <div class="tree-children" id="ch_a2oj">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">Coming soon</span></div>
      </div></div>
  </div>

  <!-- TAB PANEL 1: SETTINGS VIEW (Matches Screenshot Cards) -->
  <div class="tab-panel" id="panelSettings">
    <div class="settings-container">

      <!-- SECTION 1: GENERAL -->
      <div class="settings-card">
        <div class="card-header">General</div>
        <div class="card-body">
          <!-- Default language of file creation -->
          <div class="setting-group">
            <label class="setting-label">default language of file creation</label>
            <select class="select-input" id="setting_defaultFileExtension" onchange="onSettingChange('defaultFileExtension', this.value)">
              <option value="Select everytime">Select everytime</option>
              <option value=".cpp">C++ (.cpp)</option>
              <option value=".py">Python (.py)</option>
              <option value=".java">Java (.java)</option>
              <option value=".c">C (.c)</option>
              <option value=".cs">C# (.cs)</option>
              <option value=".go">Go (.go)</option>
              <option value=".hs">Haskell (.hs)</option>
              <option value=".kt">Kotlin (.kt)</option>
              <option value=".php">PHP (.php)</option>
              <option value=".rb">Ruby (.rb)</option>
              <option value=".rs">Rust (.rs)</option>
              <option value=".js">JavaScript (.js)</option>
            </select>
            <div class="setting-hint">Default file extension used when clicking 'Code Now'.</div>
          </div>

          <!-- Compilers -->
          <div class="setting-group">
            <label class="setting-label">Compilers</label>
            <table class="compilers-table" id="compilersTable">
              <!-- Dynamically populated -->
            </table>
            <div class="setting-hint">Configure preferred compiler or interpreter command per language.</div>
          </div>
        </div>
      </div>

      <!-- SECTION 2: CODEFORCES -->
      <div class="settings-card">
        <div class="card-header">Codeforces</div>
        <div class="card-body">
          <!-- File Creation Name -->
          <div class="setting-group">
            <label class="setting-label">File Creation Name</label>
            <input type="text" class="text-input" id="setting_codeforcesFileName" onchange="onSettingChange('codeforcesFileName', this.value)" placeholder="{problemId}-{problemName}{fileExtension}" />
            <div class="setting-hint">Placeholders: {problemId}, {problemName}, {contestId}, {problemIndex}, {fileExtension}</div>
          </div>

          <!-- File Creation Path -->
          <div class="setting-group">
            <label class="setting-label">File Creation Path</label>
            <div class="input-row">
              <input type="text" class="text-input" id="setting_codeforcesFileCreationDirectory" onchange="onSettingChange('codeforcesFileCreationDirectory', this.value)" placeholder="Leave empty for workspace root" />
              <button class="btn" onclick="browseFolder('codeforcesFileCreationDirectory')" title="Browse Folder">📁</button>
            </div>
            <div class="setting-hint">Directory where 'Code Now' saves generated Codeforces solution files.</div>
          </div>

          <!-- Username -->
          <div class="setting-group">
            <label class="setting-label">Username</label>
            <div class="input-row">
              <input type="text" class="text-input" id="setting_codeforcesUsername" onchange="onSettingChange('codeforcesUsername', this.value)" placeholder="e.g. tourist" />
              <button class="btn btn-primary" onclick="syncUserHandle()" title="Sync user submissions">Sync</button>
            </div>
            <div id="codeforcesUserStatus" class="user-status-badge" style="display: none;"></div>
            <div class="setting-hint">Codeforces handle to track solved submissions and user rating.</div>
          </div>

          <!-- Cookie Path -->
          <div class="setting-group">
            <label class="setting-label">Cookie Path</label>
            <div class="input-row">
              <input type="text" class="text-input" id="setting_codeforcesCookiePath" onchange="onSettingChange('codeforcesCookiePath', this.value)" placeholder="Path to Brave/Chrome cookies file" />
              <button class="btn" onclick="browseFile('codeforcesCookiePath', 'Select Codeforces Cookies File')" title="Browse Cookie File">📁</button>
            </div>
            <div class="setting-hint">Path to Brave/Chrome cookies for Cloudflare bypass.</div>
          </div>
        </div>
      </div>

      <!-- SECTION 3: CSES -->
      <div class="settings-card">
        <div class="card-header">CSES</div>
        <div class="card-body">
          <!-- File Creation Name -->
          <div class="setting-group">
            <label class="setting-label">File Creation Name</label>
            <input type="text" class="text-input" id="setting_csesFileName" onchange="onSettingChange('csesFileName', this.value)" placeholder="{problemId}-{problemName}{fileExtension}" />
            <div class="setting-hint">Placeholders: {problemId}, {problemName}, {fileExtension}</div>
          </div>

          <!-- File Creation Path -->
          <div class="setting-group">
            <label class="setting-label">File Creation Path</label>
            <div class="input-row">
              <input type="text" class="text-input" id="setting_csesFileCreationDirectory" onchange="onSettingChange('csesFileCreationDirectory', this.value)" placeholder="Leave empty for workspace root" />
              <button class="btn" onclick="browseFolder('csesFileCreationDirectory')" title="Browse Folder">📁</button>
            </div>
            <div class="setting-hint">Directory where 'Code Now' saves generated CSES solution files.</div>
          </div>

          <!-- Username -->
          <div class="setting-group">
            <label class="setting-label">Username</label>
            <input type="text" class="text-input" id="setting_csesUsername" onchange="onSettingChange('csesUsername', this.value)" placeholder="CSES username or email" />
            <div class="setting-hint">CSES account username or email for problem tracking and submissions.</div>
          </div>

          <!-- Cookie Path -->
          <div class="setting-group">
            <label class="setting-label">Cookie Path</label>
            <div class="input-row">
              <input type="text" class="text-input" id="setting_csesCookiePath" onchange="onSettingChange('csesCookiePath', this.value)" placeholder="Path to CSES cookie file" />
              <button class="btn" onclick="browseFile('csesCookiePath', 'Select CSES Cookie File')" title="Browse Cookie File">📁</button>
            </div>
            <div class="setting-hint">Path to CSES cookie file for authentication.</div>
          </div>
        </div>
      </div>

    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let meta = null;
    let settingsData = null;
    const bucketCache = {};
    const bucketCacheRaw = {};
    const sectionSorts = {};
    const subSectionSorts = {};
    let allCurrentOffset = 0;
    let csesCurrentOffset = 0;

    function adjustSelectWidth(sel) {
      if (!sel) return;
      var text = sel.options && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : (sel.value || 'Sort ▾');
      if (!window._textMeasureCanvas) {
        window._textMeasureCanvas = document.createElement('canvas');
      }
      var ctx = window._textMeasureCanvas.getContext('2d');
      if (ctx) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
        var w = Math.ceil(ctx.measureText(text).width);
        sel.style.width = (w + 2) + 'px';
      }
    }

    function getSectionForBucketType(bucketType) {
      if (bucketType === 'rating') return 'rating';
      if (bucketType === 'tag') return 'tag';
      if (bucketType === 'contest') return 'past';
      if (bucketType === 'csesCat') return 'cses-cat';
      return bucketType;
    }

    function getBucketTypeForSection(sectionId) {
      if (sectionId === 'rating') return 'rating';
      if (sectionId === 'tag') return 'tag';
      if (sectionId === 'past') return 'contest';
      if (sectionId === 'cses-cat') return 'csesCat';
      return sectionId;
    }

    function renderSortDropdown(subId, isRatingSection, activeSort, bucketType, key) {
      var current = activeSort || 'default';
      if (current === 'name') current = 'name_asc';
      if (current === 'contest_num') current = 'contest_num_asc';
      if (current === 'contest') current = 'contest_asc';
      if (current === 'rating') current = 'rating_desc';
      if (current === 'tags') current = 'tags_asc';

      var dataKeyAttr = bucketType ? (' data-bucket-type="' + bucketType + '" data-bucket-key="' + escapeHtml(String(key)) + '"') : '';

      var isCses = (bucketType === 'csesCat' || bucketType === 'cses' || (subId && subId.indexOf('cses') !== -1));
      if (isCses) {
        return '<select class="sort-select" id="sort_' + subId + '" data-sub-id="' + subId + '"' + dataKeyAttr + ' ' +
          'onclick="event.stopPropagation()" ' +
          'onmousedown="event.stopPropagation()" ' +
          'onchange="handleSortSelectChange(this)">' +
          '<option value="default"' + (current === 'default' ? ' selected' : '') + '>Sort ▾</option>' +
          '<option value="name_asc"' + (current === 'name_asc' ? ' selected' : '') + '>PS-Name (Asc) ▾</option>' +
          '<option value="name_desc"' + (current === 'name_desc' ? ' selected' : '') + '>PS-Name (Desc) ▾</option>' +
          '</select>';
      }

      var html = '<select class="sort-select" id="sort_' + subId + '" data-sub-id="' + subId + '"' + dataKeyAttr + ' ' +
        'onclick="event.stopPropagation()" ' +
        'onmousedown="event.stopPropagation()" ' +
        'onchange="handleSortSelectChange(this)">' +
        '<option value="default"' + (current === 'default' ? ' selected' : '') + '>Sort ▾</option>' +
        '<option value="name_asc"' + (current === 'name_asc' ? ' selected' : '') + '>PS-Name (Asc) ▾</option>' +
        '<option value="name_desc"' + (current === 'name_desc' ? ' selected' : '') + '>PS-Name (Desc) ▾</option>' +
        '<option value="contest_num_asc"' + (current === 'contest_num_asc' ? ' selected' : '') + '>Contest-Number (Asc) ▾</option>' +
        '<option value="contest_num_desc"' + (current === 'contest_num_desc' ? ' selected' : '') + '>Contest-Number (Desc) ▾</option>' +
        '<option value="contest_asc"' + (current === 'contest_asc' ? ' selected' : '') + '>Contest-Name (Asc) ▾</option>' +
        '<option value="contest_desc"' + (current === 'contest_desc' ? ' selected' : '') + '>Contest-Name (Desc) ▾</option>';

      if (!isRatingSection) {
        html += '<option value="rating_asc"' + (current === 'rating_asc' ? ' selected' : '') + '>Rating (Asc) ▾</option>' +
                '<option value="rating_desc"' + (current === 'rating_desc' ? ' selected' : '') + '>Rating (Desc) ▾</option>';
      }

      html += '<option value="tags_asc"' + (current === 'tags_asc' ? ' selected' : '') + '>Tags (Asc) ▾</option>' +
              '<option value="tags_desc"' + (current === 'tags_desc' ? ' selected' : '') + '>Tags (Desc) ▾</option>' +
              '</select>';
      return html;
    }

    function handleSortSelectChange(sel) {
      var subId = sel.getAttribute('data-sub-id');
      var bucketType = sel.getAttribute('data-bucket-type');
      var key = sel.getAttribute('data-bucket-key');
      var sortValue = sel.value;
      adjustSelectWidth(sel);
      if (bucketType) {
        onSubSortChange(subId, bucketType, key, sortValue);
      } else {
        onSortChange(subId, sortValue);
      }
    }

    function handleSubNodeClick(el) {
      var subId = el.getAttribute('data-sub-id');
      var bucketType = el.getAttribute('data-bucket-type');
      var key = el.getAttribute('data-bucket-key');
      toggleSubNode(subId, bucketType, key);
    }

    function sortProblemList(list, sortValue) {
      var copy = list.slice();
      switch (sortValue) {
        case 'name':
        case 'name_asc':
          return copy.sort(function(a, b) {
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });
        case 'name_desc':
          return copy.sort(function(a, b) {
            return (b.name || '').localeCompare(a.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });

        case 'contest_num':
        case 'contest_num_asc':
          return copy.sort(function(a, b) {
            var cA = a.contestId || a.taskId || 0;
            var cB = b.contestId || b.taskId || 0;
            if (cA !== cB) return cA - cB;
            return (a.index || '').localeCompare(b.index || '', undefined, { numeric: true });
          });
        case 'contest_num_desc':
          return copy.sort(function(a, b) {
            var cA = a.contestId || a.taskId || 0;
            var cB = b.contestId || b.taskId || 0;
            if (cA !== cB) return cB - cA;
            return (a.index || '').localeCompare(b.index || '', undefined, { numeric: true });
          });

        case 'contest':
        case 'contest_asc':
          return copy.sort(function(a, b) {
            var cA = a.contestName || (a.contestId ? ('Contest ' + a.contestId) : (a.category || ''));
            var cB = b.contestName || (b.contestId ? ('Contest ' + b.contestId) : (b.category || ''));
            var cmp = cA.localeCompare(cB, undefined, { numeric: true, sensitivity: 'base' });
            if (cmp !== 0) return cmp;
            return (a.index || '').localeCompare(b.index || '', undefined, { numeric: true });
          });
        case 'contest_desc':
          return copy.sort(function(a, b) {
            var cA = a.contestName || (a.contestId ? ('Contest ' + a.contestId) : (a.category || ''));
            var cB = b.contestName || (b.contestId ? ('Contest ' + b.contestId) : (b.category || ''));
            var cmp = cB.localeCompare(cA, undefined, { numeric: true, sensitivity: 'base' });
            if (cmp !== 0) return cmp;
            return (a.index || '').localeCompare(b.index || '', undefined, { numeric: true });
          });

        case 'rating_asc':
          return copy.sort(function(a, b) {
            if (a.isCses || b.isCses) {
              return (a.solvedCount || 0) - (b.solvedCount || 0);
            }
            var rA = (a.rating !== undefined && a.rating !== null && a.rating > 0) ? a.rating : 999999;
            var rB = (b.rating !== undefined && b.rating !== null && b.rating > 0) ? b.rating : 999999;
            if (rA !== rB) return rA - rB;
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });
        case 'rating':
        case 'rating_desc':
          return copy.sort(function(a, b) {
            if (a.isCses || b.isCses) {
              return (b.solvedCount || 0) - (a.solvedCount || 0);
            }
            var rA = (a.rating !== undefined && a.rating !== null && a.rating > 0) ? a.rating : -1;
            var rB = (b.rating !== undefined && b.rating !== null && b.rating > 0) ? b.rating : -1;
            if (rA !== rB) return rB - rA;
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });

        case 'tags':
        case 'tags_asc':
          return copy.sort(function(a, b) {
            var tA = (a.tags && a.tags.length > 0) ? a.tags.join(', ') : (a.category || 'zzz');
            var tB = (b.tags && b.tags.length > 0) ? b.tags.join(', ') : (b.category || 'zzz');
            var cmp = tA.localeCompare(tB, undefined, { sensitivity: 'base' });
            if (cmp !== 0) return cmp;
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });
        case 'tags_desc':
          return copy.sort(function(a, b) {
            var tA = (a.tags && a.tags.length > 0) ? a.tags.join(', ') : (a.category || '');
            var tB = (b.tags && b.tags.length > 0) ? b.tags.join(', ') : (b.category || '');
            var cmp = tB.localeCompare(tA, undefined, { sensitivity: 'base' });
            if (cmp !== 0) return cmp;
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
          });

        default:
          if (copy.length > 0 && copy[0].isCses) {
            return copy.sort(function(a, b) {
              return (a.taskId || 0) - (b.taskId || 0);
            });
          }
          return copy;
      }
    }

    function applySortAndRender(cacheKey, sortValue) {
      var raw = bucketCacheRaw[cacheKey];
      if (!raw) return;

      var sorted = raw.slice();
      sorted = sortProblemList(sorted, sortValue);
      bucketCache[cacheKey] = sorted;

      var colonIdx = cacheKey.indexOf(':');
      var bucketType = cacheKey.substring(0, colonIdx);

      var ch = null;
      document.querySelectorAll('.tree-children').forEach(function(el) {
        if (el.getAttribute('data-cache-key') === cacheKey) {
          ch = el;
        }
      });

      if (ch) {
        if (bucketType === 'csesCat') {
          ch.innerHTML = renderCsesProblemRows(sorted);
        } else {
          ch.innerHTML = renderProblemRows(sorted);
        }
      }
    }

    function onSubSortChange(subId, bucketType, key, sortValue) {
      var cacheKey = bucketType + ':' + key;
      subSectionSorts[cacheKey] = sortValue;

      var ch = document.getElementById('subch_' + subId);
      var tw = document.getElementById('subtw_' + subId);

      if (ch && !ch.classList.contains('open')) {
        ch.classList.add('open');
        if (tw) tw.classList.add('expanded');
      }

      if (bucketCacheRaw[cacheKey]) {
        applySortAndRender(cacheKey, sortValue);
      } else {
        if (ch) {
          ch.innerHTML = '<div class="tree-row indent-2"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
        }
        vscode.postMessage({ type: 'loadBucket', bucketType: bucketType, key: key, sort: sortValue });
      }
    }

    function onSortChange(sectionId, sortValue) {
      sectionSorts[sectionId] = sortValue;

      var ch = document.getElementById('ch_' + sectionId);
      var tw = document.getElementById('tw_' + sectionId);

      if (ch && !ch.classList.contains('open')) {
        ch.classList.add('open');
        if (tw) tw.classList.add('expanded');
      }

      if (sectionId === 'all') {
        bucketCache['all'] = null;
        bucketCacheRaw['all'] = null;
        allCurrentOffset = 0;
        if (ch) {
          ch.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
        }
        vscode.postMessage({ type: 'loadBucket', bucketType: 'all', offset: 0, limit: 50, sort: sortValue });
        return;
      }

      if (sectionId === 'cses-all') {
        bucketCache['cses'] = null;
        bucketCacheRaw['cses'] = null;
        csesCurrentOffset = 0;
        if (ch) {
          ch.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
        }
        vscode.postMessage({ type: 'loadBucket', bucketType: 'cses', offset: 0, limit: 50, sort: sortValue });
        return;
      }

      if (ch) {
        var selects = ch.querySelectorAll('.sort-select');
        selects.forEach(function(s) {
          if (sectionId === 'rating' && sortValue === 'rating') return;
          s.value = sortValue;
          adjustSelectWidth(s);
        });
      }

      var bType = getBucketTypeForSection(sectionId);
      Object.keys(bucketCacheRaw).forEach(function(cacheKey) {
        if (cacheKey.indexOf(bType + ':') === 0) {
          subSectionSorts[cacheKey] = sortValue;
          applySortAndRender(cacheKey, sortValue);
        }
      });

      expandCategory(sectionId, true);
    }

    // Switch Tabs: 0 = Problems, 1 = Settings
    function switchTab(idx) {
      document.getElementById('tabBtn0').classList.toggle('active', idx === 0);
      document.getElementById('tabBtn1').classList.toggle('active', idx === 1);
      document.getElementById('panelProblems').classList.toggle('active', idx === 0);
      document.getElementById('panelSettings').classList.toggle('active', idx === 1);
    }

    document.getElementById('tabBtn0').addEventListener('click', () => switchTab(0));
    document.getElementById('tabBtn1').addEventListener('click', () => switchTab(1));

    // Native Tree Toggle
    function toggleNode(id) {
      const tw = document.getElementById('tw_' + id);
      const ch = document.getElementById('ch_' + id);
      if (!tw || !ch) return;

      const isOpen = ch.classList.contains('open');
      if (isOpen) {
        ch.classList.remove('open');
        tw.classList.remove('expanded');
      } else {
        ch.classList.add('open');
        tw.classList.add('expanded');
        expandCategory(id);
      }
    }

    function toggleSubNode(subId, bucketType, key) {
      const tw = document.getElementById('subtw_' + subId);
      const ch = document.getElementById('subch_' + subId);
      if (!tw || !ch) return;

      const isOpen = ch.classList.contains('open');
      if (isOpen) {
        ch.classList.remove('open');
        tw.classList.remove('expanded');
      } else {
        ch.classList.add('open');
        tw.classList.add('expanded');
        
        var cacheKey = bucketType + ':' + key;
        if (!bucketCacheRaw[cacheKey]) {
          ch.innerHTML = '<div class="tree-row indent-2"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          var parentType = getSectionForBucketType(bucketType);
          var sort = subSectionSorts[cacheKey] || sectionSorts[parentType] || 'default';
          vscode.postMessage({ type: 'loadBucket', bucketType: bucketType, key: key, sort: sort });
        }
      }
    }

    // Problem Click Handlers
    function openCfProblem(contestId, index, name, rating) {
      vscode.postMessage({
        type: 'openProblem',
        problem: { contestId, index, name, rating }
      });
    }

    function handleCfProblemClick(el) {
      var contestId = parseInt(el.getAttribute('data-contest-id') || '0', 10);
      var index = el.getAttribute('data-index') || '';
      var name = el.getAttribute('data-name') || '';
      var rating = parseInt(el.getAttribute('data-rating') || '0', 10) || undefined;
      openCfProblem(contestId, index, name, rating);
    }

    function openCsesProblem(taskId, name, category, url) {
      vscode.postMessage({
        type: 'openCsesProblem',
        problem: { id: String(taskId), taskId: parseInt(taskId) || 0, name, category, url, isCses: true }
      });
    }

    function handleCsesProblemClick(el) {
      var taskId = el.getAttribute('data-task-id') || '';
      var name = el.getAttribute('data-name') || '';
      var category = el.getAttribute('data-category') || '';
      var url = el.getAttribute('data-url') || '';
      openCsesProblem(taskId, name, category, url);
    }

    // Status icon helper matching generateStatusIcon in problems-view.ts
    function getStatusSlotHtml(probId) {
      const status = meta && meta.userProblems ? meta.userProblems[probId] : null;
      if (status) {
        const cls = status.startsWith('+') ? 'status-pos' : 'status-neg';
        return '<span class="status-slot ' + cls + '">' + escapeHtml(status) + '</span>';
      }
      return '<span class="status-slot"></span>';
    }

    // Codeforces Rating & Rank Colors
    function getRatingColor(rating) {
      if (!rating || rating === '?' || rating === 'Unknown') return '#888888';
      const r = Number(rating);
      if (isNaN(r)) return '#888888';
      if (r < 1200) return '#808080'; // Newbie (Gray)
      if (r < 1400) return '#00a843'; // Pupil (Green)
      if (r < 1600) return '#03a89e'; // Specialist (Cyan)
      if (r < 1900) return '#3582ff'; // Expert (Blue)
      if (r < 2100) return '#bb33bb'; // Candidate Master (Purple)
      if (r < 2400) return '#ff8c00'; // Master (Orange)
      return '#ff3d3d';               // Grandmaster+ (Red)
    }

    function getRankBadge(rating) {
      if (!rating || rating === '?' || rating === 'Unknown') return '';
      const r = Number(rating);
      if (isNaN(r)) return '';
      if (r < 1200) return 'NE';
      if (r < 1400) return 'PU';
      if (r < 1600) return 'SP';
      if (r < 1900) return 'EX';
      if (r < 2100) return 'CM';
      if (r < 2400) return 'MA';
      if (r < 2600) return 'GM';
      if (r < 3000) return 'IG';
      return 'LG';
    }

    function renderCfProblemRow(p, indentClass) {
      const id = (p.contestId ? p.contestId : '') + p.index;
      const color = getRatingColor(p.rating);
      const badge = getRankBadge(p.rating);
      const escName = escapeHtml(p.name);
      var labelStyle = p.rating ? (' style="color: ' + color + ';"') : '';
      var ratingDesc = p.rating ? ('<span class="tree-description" style="color: ' + color + '; font-weight: 600;">★ ' + p.rating + '</span>' + (badge ? ('<span class="rank-badge" style="color: ' + color + '; border-color: ' + color + ';">' + badge + '</span>') : '')) : '';
      return '<div class="tree-row ' + indentClass + '" data-contest-id="' + (p.contestId || 0) + '" data-index="' + escapeHtml(p.index || '') + '" data-name="' + escName + '" data-rating="' + (p.rating || 0) + '" onclick="handleCfProblemClick(this)">' +
        getStatusSlotHtml(id) +
        '<span class="tree-label"' + labelStyle + '>[' + id + '] ' + escName + '</span>' +
        ratingDesc +
      '</div>';
    }

    // Expand category on demand
    function expandCategory(catId, preserveOpenState) {
      if (!meta) return;
      var container = document.getElementById('ch_' + catId);
      if (!container) return;

      var openSubIds = new Set();
      if (preserveOpenState) {
        container.querySelectorAll('.tree-children.open').forEach(function(el) {
          openSubIds.add(el.id);
        });
      }

      if (catId === 'all') {
        if (!bucketCache['all']) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          allCurrentOffset = 0;
          var sort = sectionSorts['all'] || 'default';
          vscode.postMessage({ type: 'loadBucket', bucketType: 'all', offset: 0, limit: 50, sort: sort });
        }
      } else if (catId === 'rating') {
        var ratings = (meta.ratings || []).slice();
        var activeCatSort = sectionSorts['rating'];
        if (activeCatSort === 'rating_desc') {
          ratings.sort(function(a, b) { return (Number(b.rating) || 0) - (Number(a.rating) || 0); });
        } else if (activeCatSort === 'rating_asc') {
          ratings.sort(function(a, b) { return (Number(a.rating) || 0) - (Number(b.rating) || 0); });
        }
        container.innerHTML = ratings.map(function(r, i) {
          var subId = 'rating_' + i;
          var color = getRatingColor(r.rating);
          var badge = r.description || getRankBadge(r.rating);
          var activeSort = subSectionSorts['rating:' + r.rating] || sectionSorts['rating'] || 'default';
          return '<div>' +
            '<div class="tree-row indent-1" data-sub-id="' + subId + '" data-bucket-type="rating" data-bucket-key="' + r.rating + '" onclick="handleSubNodeClick(this)">' +
              '<span class="twistie" id="subtw_' + subId + '"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>' +
              '<span class="folder-icon" style="color: ' + color + ';"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>' +
              '<span class="tree-label" style="color: ' + color + '; font-weight: 600;">' + r.rating + '</span>' +
              renderSortDropdown(subId, true, activeSort, 'rating', r.rating) +
              (badge ? '<span class="rank-badge" style="color: ' + color + '; border-color: ' + color + ';">' + badge + '</span>' : '') +
              '<span class="tree-count">' + (r.count ? r.count : '') + '</span>' +
            '</div>' +
            '<div class="tree-children" id="subch_' + subId + '" data-cache-key="rating:' + r.rating + '"></div>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
      } else if (catId === 'tag') {
        var tags = (meta.tags || []).slice();
        var activeCatSort = sectionSorts['tag'];
        if (activeCatSort === 'name_desc' || activeCatSort === 'tags_desc') {
          tags.sort(function(a, b) { return b.tag.localeCompare(a.tag); });
        } else if (activeCatSort === 'name' || activeCatSort === 'name_asc' || activeCatSort === 'tags' || activeCatSort === 'tags_asc') {
          tags.sort(function(a, b) { return a.tag.localeCompare(b.tag); });
        }
        container.innerHTML = tags.map(function(t, i) {
          var subId = 'tag_' + i;
          var activeSort = subSectionSorts['tag:' + t.rawTag] || activeCatSort || 'default';
          return '<div>' +
            '<div class="tree-row indent-1" data-sub-id="' + subId + '" data-bucket-type="tag" data-bucket-key="' + t.rawTag + '" onclick="handleSubNodeClick(this)">' +
              '<span class="twistie" id="subtw_' + subId + '"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>' +
              '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>' +
              '<span class="tree-label">' + escapeHtml(t.tag) + '</span>' +
              renderSortDropdown(subId, false, activeSort, 'tag', t.rawTag) +
              '<span class="tree-description">' + t.count + '</span>' +
            '</div>' +
            '<div class="tree-children" id="subch_' + subId + '" data-cache-key="tag:' + t.rawTag + '"></div>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
      } else if (catId === 'past') {
        var past = (meta.pastContests || []).slice();
        var activeCatSort = sectionSorts['past'];
        if (activeCatSort === 'name_desc' || activeCatSort === 'contest_desc') {
          past.sort(function(a, b) { return b.name.localeCompare(a.name); });
        } else if (activeCatSort === 'name' || activeCatSort === 'name_asc' || activeCatSort === 'contest' || activeCatSort === 'contest_asc') {
          past.sort(function(a, b) { return a.name.localeCompare(b.name); });
        } else if (activeCatSort === 'contest_num_asc') {
          past.sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
        } else if (activeCatSort === 'contest_num' || activeCatSort === 'contest_num_desc' || activeCatSort === 'rating' || activeCatSort === 'rating_desc') {
          past.sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
        }
        container.innerHTML = past.map(function(c, i) {
          var subId = 'past_' + i;
          var activeSort = subSectionSorts['contest:' + c.id] || activeCatSort || 'default';
          return '<div>' +
            '<div class="tree-row indent-1" data-sub-id="' + subId + '" data-bucket-type="contest" data-bucket-key="' + c.id + '" onclick="handleSubNodeClick(this)">' +
              '<span class="twistie" id="subtw_' + subId + '"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>' +
              '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>' +
              '<span class="tree-label">[' + c.id + '] ' + escapeHtml(c.name) + '</span>' +
              renderSortDropdown(subId, false, activeSort, 'contest', c.id) +
              '<span class="tree-description">' + c.count + ' problems</span>' +
            '</div>' +
            '<div class="tree-children" id="subch_' + subId + '" data-cache-key="contest:' + c.id + '"></div>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
      } else if (catId === 'upcoming') {
        var up = (meta.upcomingContests || []).slice();
        var activeCatSort = sectionSorts['upcoming'];
        if (activeCatSort === 'name_desc' || activeCatSort === 'contest_desc') {
          up.sort(function(a, b) { return b.name.localeCompare(a.name); });
        } else if (activeCatSort === 'name' || activeCatSort === 'name_asc' || activeCatSort === 'contest' || activeCatSort === 'contest_asc') {
          up.sort(function(a, b) { return a.name.localeCompare(b.name); });
        } else if (activeCatSort === 'contest_num_asc') {
          up.sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
        } else if (activeCatSort === 'contest_num' || activeCatSort === 'contest_num_desc') {
          up.sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
        }
        if (up.length === 0) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="tree-label" style="opacity: 0.6;">No upcoming contests</span></div>';
          return;
        }
        container.innerHTML = up.map(function(c) {
          var remaining = c.startTimeSeconds ? (c.startTimeSeconds - Math.floor(Date.now() / 1000)) : 0;
          var timeStr = 'Starting soon';
          if (remaining > 0) {
            var d = Math.floor(remaining / 86400);
            var h = Math.floor((remaining % 86400) / 3600);
            var m = Math.floor((remaining % 3600) / 60);
            timeStr = 'Starts in ' + (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm';
          }
          return '<div class="tree-row indent-1">' +
            '<span class="status-slot"></span>' +
            '<span class="tree-label">' + escapeHtml(c.name) + '</span>' +
            '<span class="tree-description">' + timeStr + '</span>' +
          '</div>';
        }).join('');
      } else if (catId === 'cses-all') {
        if (!bucketCache['cses']) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          csesCurrentOffset = 0;
          var sort = sectionSorts['cses-all'] || 'default';
          vscode.postMessage({ type: 'loadBucket', bucketType: 'cses', offset: 0, limit: 50, sort: sort });
        }
      } else if (catId === 'cses-cat') {
        var cats = (meta.csesCategories || []).slice();
        var activeCatSort = sectionSorts['cses-cat'];
        if (activeCatSort === 'name_desc') {
          cats.sort(function(a, b) { return b.category.localeCompare(a.category); });
        } else if (activeCatSort === 'name' || activeCatSort === 'name_asc') {
          cats.sort(function(a, b) { return a.category.localeCompare(b.category); });
        }
        container.innerHTML = cats.map(function(c, i) {
          var subId = 'cses_cat_' + i;
          var activeSort = subSectionSorts['csesCat:' + c.category] || activeCatSort || 'default';
          return '<div>' +
            '<div class="tree-row indent-1" data-sub-id="' + subId + '" data-bucket-type="csesCat" data-bucket-key="' + escapeHtml(c.category) + '" onclick="handleSubNodeClick(this)">' +
              '<span class="twistie" id="subtw_' + subId + '"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>' +
              '<span class="folder-icon" style="color: #10b981;"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>' +
              '<span class="tree-label">' + escapeHtml(c.category) + '</span>' +
              renderSortDropdown(subId, false, activeSort, 'csesCat', c.category) +
              '<span class="tree-description">' + c.count + ' problems</span>' +
            '</div>' +
            '<div class="tree-children" id="subch_' + subId + '" data-cache-key="csesCat:' + escapeHtml(c.category) + '"></div>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
      }

      if (openSubIds.size > 0) {
        openSubIds.forEach(function(subChId) {
          var subCh = document.getElementById(subChId);
          var subTw = document.getElementById(subChId.replace('subch_', 'subtw_'));
          if (subCh) subCh.classList.add('open');
          if (subTw) subTw.classList.add('expanded');
          var cacheKey = subCh ? subCh.getAttribute('data-cache-key') : null;
          if (cacheKey && bucketCacheRaw[cacheKey]) {
            var activeSort = subSectionSorts[cacheKey] || sectionSorts[catId] || 'default';
            applySortAndRender(cacheKey, activeSort);
          }
        });
      }
    }

    function renderProblemRows(problems) {
      return (problems || []).map(function(p) { return renderCfProblemRow(p, 'indent-2'); }).join('');
    }

    function renderCsesProblemRow(p, indentClass) {
      var escName = escapeHtml(p.name);
      var escCat = escapeHtml(p.category || '');
      var desc = p.solvedCount ? ('✓ ' + p.solvedCount.toLocaleString()) : escCat;
      return '<div class="tree-row ' + indentClass + '" data-task-id="' + escapeHtml(String(p.taskId || '')) + '" data-name="' + escName + '" data-category="' + escCat + '" data-url="' + escapeHtml(p.url || '') + '" onclick="handleCsesProblemClick(this)">' +
        '<span class="status-slot"></span>' +
        '<span class="tree-label">[' + p.taskId + '] ' + escName + '</span>' +
        '<span class="tree-description">' + desc + '</span>' +
      '</div>';
    }

    function renderCsesProblemRows(problems) {
      return (problems || []).map(function(p) { return renderCsesProblemRow(p, 'indent-2'); }).join('');
    }

    function loadMoreAll() {
      allCurrentOffset += 50;
      var sort = sectionSorts['all'] || 'default';
      vscode.postMessage({ type: 'loadBucket', bucketType: 'all', offset: allCurrentOffset, limit: 50, sort: sort });
    }

    function loadMoreCses() {
      csesCurrentOffset += 50;
      var sort = sectionSorts['cses-all'] || 'default';
      vscode.postMessage({ type: 'loadBucket', bucketType: 'cses', offset: csesCurrentOffset, limit: 50, sort: sort });
    }

    // Populate bucket data received lazily from extension
    function onBucketDataReceived(data) {
      var bucketType = data.bucketType;
      var key = data.key;
      var problems = data.problems;
      var offset = data.offset || 0;
      var hasMore = data.hasMore;
      var total = data.total;
      var cacheKey = bucketType + ':' + key;

      if (bucketType === 'all') {
        var container = document.getElementById('ch_all');
        if (!container) return;
        if (offset === 0 || !bucketCache['all']) {
          bucketCache['all'] = problems.slice();
        } else {
          bucketCache['all'].push.apply(bucketCache['all'], problems);
        }

        var html = bucketCache['all'].map(function(p) { return renderCfProblemRow(p, 'indent-1'); }).join('');

        if (hasMore) {
          html += '<div class="load-more-row" onclick="loadMoreAll()">Load more problems (' + (total - bucketCache['all'].length) + ' remaining)...</div>';
        }
        container.innerHTML = html;
      } else if (bucketType === 'cses') {
        var container = document.getElementById('ch_cses-all');
        if (!container) return;
        if (offset === 0 || !bucketCache['cses']) {
          bucketCache['cses'] = problems.slice();
        } else {
          bucketCache['cses'].push.apply(bucketCache['cses'], problems);
        }

        var html = bucketCache['cses'].map(function(p) { return renderCsesProblemRow(p, 'indent-1'); }).join('');

        if (hasMore) {
          html += '<div class="load-more-row" onclick="loadMoreCses()">Load more problems (' + (total - bucketCache['cses'].length) + ' remaining)...</div>';
        }
        container.innerHTML = html;
      } else {
        bucketCacheRaw[cacheKey] = problems;

        var parentType = getSectionForBucketType(bucketType);
        var activeSort = subSectionSorts[cacheKey] || sectionSorts[parentType] || 'default';

        var displayProblems = problems;
        if (activeSort && activeSort !== 'default') {
          displayProblems = sortProblemList(problems, activeSort);
        }
        bucketCache[cacheKey] = displayProblems;

        var ch = null;
        document.querySelectorAll('.tree-children').forEach(function(el) {
          if (el.getAttribute('data-cache-key') === cacheKey) {
            ch = el;
          }
        });

        if (ch) {
          if (bucketType === 'csesCat') {
            ch.innerHTML = renderCsesProblemRows(displayProblems);
          } else {
            ch.innerHTML = renderProblemRows(displayProblems);
          }
        }
      }
    }

    // Settings synchronization
    function onSettingChange(key, value) {
      vscode.postMessage({
        type: 'updateSetting',
        key: 'seuCF.' + key,
        value: value
      });
    }

    function onCompilerChange(lang, command) {
      if (!settingsData || !settingsData.compilers) return;
      settingsData.compilers[lang] = command;
      vscode.postMessage({
        type: 'updateSetting',
        key: 'seuCF.compilers',
        value: settingsData.compilers
      });
    }

    function handleCompilerInputChange(el) {
      var lang = el.getAttribute('data-lang');
      if (lang) {
        onCompilerChange(lang, el.value);
      }
    }

    function browseFolder(key) {
      vscode.postMessage({
        type: 'browseDirectory',
        key: 'seuCF.' + key
      });
    }

    function browseFile(key, title) {
      vscode.postMessage({
        type: 'browseFile',
        key: 'seuCF.' + key,
        title: title
      });
    }

    function syncUserHandle() {
      const handleInput = document.getElementById('setting_codeforcesUsername');
      if (handleInput && handleInput.value.trim()) {
        vscode.postMessage({
          type: 'syncUserHandle',
          handle: handleInput.value.trim()
        });
      }
    }

    function populateSettings(settings) {
      settingsData = settings;

      const selExt = document.getElementById('setting_defaultFileExtension');
      if (selExt && settings.defaultFileExtension) {
        selExt.value = settings.defaultFileExtension;
      }

      const cfFile = document.getElementById('setting_codeforcesFileName');
      if (cfFile) cfFile.value = settings.codeforcesFileName || '';

      const cfDir = document.getElementById('setting_codeforcesFileCreationDirectory');
      if (cfDir) cfDir.value = settings.codeforcesFileCreationDirectory || '';

      const cfUser = document.getElementById('setting_codeforcesUsername');
      if (cfUser) cfUser.value = settings.codeforcesUsername || '';

      const cfCookie = document.getElementById('setting_codeforcesCookiePath');
      if (cfCookie) cfCookie.value = settings.codeforcesCookiePath || '';

      const csesFile = document.getElementById('setting_csesFileName');
      if (csesFile) csesFile.value = settings.csesFileName || '';

      const csesDir = document.getElementById('setting_csesFileCreationDirectory');
      if (csesDir) csesDir.value = settings.csesFileCreationDirectory || '';

      const csesUser = document.getElementById('setting_csesUsername');
      if (csesUser) csesUser.value = settings.csesUsername || '';

      const csesCookie = document.getElementById('setting_csesCookiePath');
      if (csesCookie) csesCookie.value = settings.csesCookiePath || '';

      const statusDiv = document.getElementById('codeforcesUserStatus');
      if (statusDiv) {
        if (settings.userDetails && settings.userDetails.handle) {
          const uColor = getRatingColor(settings.userDetails.rating);
          statusDiv.style.display = 'flex';
          statusDiv.innerHTML = '<span style="color: ' + uColor + '; font-weight: bold;">✓ ' + escapeHtml(settings.userDetails.handle) + (settings.userDetails.rating ? ' (' + settings.userDetails.rating + ')' : '') + '</span> <span style="opacity: 0.7; margin-left: 6px;">(' + settings.userDetails.solvedCount + ' solved)</span>';
        } else {
          statusDiv.style.display = 'none';
        }
      }

      const table = document.getElementById('compilersTable');
      if (table && settings.compilers) {
        const languages = ['cpp', 'py', 'java', 'c', 'rs', 'go', 'js'];
        table.innerHTML = languages.map(function(lang) {
          const cmd = settings.compilers[lang] || '';
          return '<tr>' +
            '<td style="width: 45px; font-weight: 500; color: #aaa;">' + lang.toUpperCase() + ':</td>' +
            '<td><input type="text" value="' + escapeHtml(cmd) + '" data-lang="' + lang + '" onchange="handleCompilerInputChange(this)" /></td>' +
          '</tr>';
        }).join('');
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Message receiver from extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'metadata') {
        meta = msg.payload;
        // Re-render currently open top-level category if any
        document.querySelectorAll('.tree-children.open').forEach(ch => {
          const catId = ch.id.replace('ch_', '');
          expandCategory(catId, true);
        });
        document.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
      } else if (msg.type === 'bucketData') {
        onBucketDataReceived(msg);
      } else if (msg.type === 'settingsData') {
        populateSettings(msg.payload);
      }
    });

    document.querySelectorAll('.sort-select').forEach(adjustSelectWidth);
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
