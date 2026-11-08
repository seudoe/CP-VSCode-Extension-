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

  /** On-demand problem fetcher (lightweight IPC, avoids memory spikes) */
  private handleLoadBucket(msg: { bucketType: string; key?: string; offset?: number; limit?: number }) {
    if (!this._view) { return; }
    const { bucketType, key, offset = 0, limit = 50 } = msg;

    if (bucketType === 'all') {
      const all = this.problemsStore.getProblems();
      const slice = all.slice(offset, offset + limit).map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key: 'all',
        offset,
        problems: slice,
        hasMore: offset + limit < all.length,
        total: all.length
      });
    } else if (bucketType === 'rating' && key) {
      const groups = this.problemsStore.getRatingGroups();
      const list = groups[key] || [];
      const problems = list.map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems
      });
    } else if (bucketType === 'tag' && key) {
      const groups = this.problemsStore.getTagGroups();
      const list = groups[key] || [];
      const problems = list.map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems
      });
    } else if (bucketType === 'contest' && key) {
      const past = this.problemsStore.getContests().past;
      const contest = past.find(c => String(c.contest.id) === String(key));
      const problems = (contest?.problems || []).map(p => ({
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating
      }));
      this._view.webview.postMessage({
        type: 'bucketData',
        bucketType,
        key,
        problems
      });
    } else if (bucketType === 'cses') {
      const list = this.problemsStore.getCsesProblems();
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
        total: list.length
      });
    } else if (bucketType === 'csesCat' && key) {
      const map = this.problemsStore.getCsesCategoryGroups();
      const list = map.get(key) || [];
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
        problems
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
      flex-shrink: 0;
    }
    .tree-description {
      font-size: 12px;
      margin-left: 8px;
      color: var(--vscode-descriptionForeground, #999999);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.85;
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
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_all"></div>

      <!-- 2. Rating (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('rating')">
        <span class="twistie" id="tw_rating"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Rating</span>
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_rating"></div>

      <!-- 3. Tag (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('tag')">
        <span class="twistie" id="tw_tag"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Tag</span>
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_tag"></div>

      <!-- 4. Favorite (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('favorite')">
        <span class="twistie" id="tw_favorite"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Favorite</span>
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_favorite">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">No favorites</span></div>
      </div>

      <!-- 5. Past Contests (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('past')">
        <span class="twistie" id="tw_past"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Past Contests</span>
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_past"></div>

      <!-- 6. Upcoming Contests (Codeforces) -->
      <div class="tree-row indent-0" onclick="toggleNode('upcoming')">
        <span class="twistie" id="tw_upcoming"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cf">CF</span>
        <span class="tree-label">Upcoming Contests</span>
        <span class="tree-description">Codeforces</span>
      </div>
      <div class="tree-children" id="ch_upcoming"></div>

      <!-- 7. CSES Problemset (CSES) -->
      <div class="tree-row indent-0" onclick="toggleNode('cses-all')">
        <span class="twistie" id="tw_cses-all"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cses">CSES</span>
        <span class="tree-label">CSES Problemset</span>
        <span class="tree-description">CSES</span>
      </div>
      <div class="tree-children" id="ch_cses-all"></div>

      <!-- 8. CSES Categories (CSES) -->
      <div class="tree-row indent-0" onclick="toggleNode('cses-cat')">
        <span class="twistie" id="tw_cses-cat"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-cses">CSES</span>
        <span class="tree-label">CSES Categories</span>
        <span class="tree-description">CSES</span>
      </div>
      <div class="tree-children" id="ch_cses-cat"></div>

      <!-- 9. CP-31 Sheet (Future) -->
      <div class="tree-row indent-0" onclick="toggleNode('cp31')">
        <span class="twistie" id="tw_cp31"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-other">CP</span>
        <span class="tree-label">CP-31 Sheet</span>
        <span class="tree-description">Coming soon</span>
      </div>
      <div class="tree-children" id="ch_cp31">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">Coming soon</span></div>
      </div>

      <!-- 10. A2OJ Ladders (Future) -->
      <div class="tree-row indent-0" onclick="toggleNode('a2oj')">
        <span class="twistie" id="tw_a2oj"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
        <span class="badge-icon badge-other">CP</span>
        <span class="tree-label">A2OJ Ladders</span>
        <span class="tree-description">Coming soon</span>
      </div>
      <div class="tree-children" id="ch_a2oj">
        <div class="tree-row indent-1"><span class="twistie leaf"></span><span class="tree-label" style="opacity: 0.6;">Coming soon</span></div>
      </div>
    </div>
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
    let allCurrentOffset = 0;
    let csesCurrentOffset = 0;

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
        
        // Lazy load problems for this sub-bucket if not yet cached
        const cacheKey = bucketType + ':' + key;
        if (!bucketCache[cacheKey]) {
          ch.innerHTML = '<div class="tree-row indent-2"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          vscode.postMessage({ type: 'loadBucket', bucketType, key });
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

    function openCsesProblem(taskId, name, category, url) {
      vscode.postMessage({
        type: 'openCsesProblem',
        problem: { id: String(taskId), taskId: parseInt(taskId) || 0, name, category, url, isCses: true }
      });
    }

    // Status icon helper matching generateStatusIcon in problems-view.ts
    function getStatusSlotHtml(probId) {
      const status = meta && meta.userProblems ? meta.userProblems[probId] : null;
      if (status) {
        const cls = status.startsWith('+') ? 'status-pos' : 'status-neg';
        return \`<span class="status-slot \${cls}">\${escapeHtml(status)}</span>\`;
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
      return \`<div class="tree-row \${indentClass}" onclick="openCfProblem(\${p.contestId || 0}, '\${p.index}', '\${escName.replace(/'/g, "\\\\'")}', \${p.rating || 0})">
        \${getStatusSlotHtml(id)}
        <span class="tree-label" \${p.rating ? \`style="color: \${color};"\` : ''}>[\${id}] \${escName}</span>
        \${p.rating ? \`
          <span class="tree-description" style="color: \${color}; font-weight: 600;">★ \${p.rating}</span>
          \${badge ? \`<span class="rank-badge" style="color: \${color}; border-color: \${color};">\${badge}</span>\` : ''}
        \` : ''}
      </div>\`;
    }

    // Expand category on demand
    function expandCategory(catId) {
      if (!meta) return;
      const container = document.getElementById('ch_' + catId);
      if (!container) return;

      if (catId === 'all') {
        if (!bucketCache['all']) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          allCurrentOffset = 0;
          vscode.postMessage({ type: 'loadBucket', bucketType: 'all', offset: 0, limit: 50 });
        }
      } else if (catId === 'rating') {
        const ratings = meta.ratings || [];
        container.innerHTML = ratings.map((r, i) => {
          const subId = 'rating_' + i;
          const color = getRatingColor(r.rating);
          const badge = r.description || getRankBadge(r.rating);
          return \`<div>
            <div class="tree-row indent-1" onclick="toggleSubNode('\${subId}', 'rating', '\${r.rating}')">
              <span class="twistie" id="subtw_\${subId}"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
              <span class="folder-icon" style="color: \${color};"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>
              <span class="tree-label" style="color: \${color}; font-weight: 600;">\${r.rating}</span>
              \${badge ? \`<span class="rank-badge" style="color: \${color}; border-color: \${color};">\${badge}</span>\` : ''}
              <span class="tree-count">\${r.count ? r.count : ''}</span>
            </div>
            <div class="tree-children" id="subch_\${subId}"></div>
          </div>\`;
        }).join('');
      } else if (catId === 'tag') {
        const tags = meta.tags || [];
        container.innerHTML = tags.map((t, i) => {
          const subId = 'tag_' + i;
          return \`<div>
            <div class="tree-row indent-1" onclick="toggleSubNode('\${subId}', 'tag', '\${t.rawTag}')">
              <span class="twistie" id="subtw_\${subId}"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
              <span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>
              <span class="tree-label">\${escapeHtml(t.tag)}</span>
              <span class="tree-description">\${t.count}</span>
            </div>
            <div class="tree-children" id="subch_\${subId}"></div>
          </div>\`;
        }).join('');
      } else if (catId === 'past') {
        const past = meta.pastContests || [];
        container.innerHTML = past.map((c, i) => {
          const subId = 'past_' + i;
          return \`<div>
            <div class="tree-row indent-1" onclick="toggleSubNode('\${subId}', 'contest', '\${c.id}')">
              <span class="twistie" id="subtw_\${subId}"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
              <span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>
              <span class="tree-label">[\${c.id}] \${escapeHtml(c.name)}</span>
              <span class="tree-description">\${c.count} problems</span>
            </div>
            <div class="tree-children" id="subch_\${subId}"></div>
          </div>\`;
        }).join('');
      } else if (catId === 'upcoming') {
        const up = meta.upcomingContests || [];
        if (up.length === 0) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="tree-label" style="opacity: 0.6;">No upcoming contests</span></div>';
          return;
        }
        container.innerHTML = up.map(c => {
          const remaining = c.startTimeSeconds ? (c.startTimeSeconds - Math.floor(Date.now() / 1000)) : 0;
          let timeStr = 'Starting soon';
          if (remaining > 0) {
            const d = Math.floor(remaining / 86400);
            const h = Math.floor((remaining % 86400) / 3600);
            const m = Math.floor((remaining % 3600) / 60);
            timeStr = 'Starts in ' + (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm';
          }
          return \`<div class="tree-row indent-1">
            <span class="status-slot"></span>
            <span class="tree-label">\${escapeHtml(c.name)}</span>
            <span class="tree-description">\${timeStr}</span>
          </div>\`;
        }).join('');
      } else if (catId === 'cses-all') {
        if (!bucketCache['cses']) {
          container.innerHTML = '<div class="tree-row indent-1"><span class="status-slot"></span><span class="tree-label" style="opacity: 0.6;">Loading...</span></div>';
          csesCurrentOffset = 0;
          vscode.postMessage({ type: 'loadBucket', bucketType: 'cses', offset: 0, limit: 50 });
        }
      } else if (catId === 'cses-cat') {
        const cats = meta.csesCategories || [];
        container.innerHTML = cats.map((c, i) => {
          const subId = 'cses_cat_' + i;
          return \`<div>
            <div class="tree-row indent-1" onclick="toggleSubNode('\${subId}', 'csesCat', '\${escapeHtml(c.category)}')">
              <span class="twistie" id="subtw_\${subId}"><svg width="8" height="8" viewBox="0 0 8 8"><polygon points="2,1 6,4 2,7" fill="currentColor"/></svg></span>
              <span class="folder-icon" style="color: #10b981;"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V13H2V3h4l1.5 1.5H14z"/></svg></span>
              <span class="tree-label">\${escapeHtml(c.category)}</span>
              <span class="tree-description">\${c.count} problems</span>
            </div>
            <div class="tree-children" id="subch_\${subId}"></div>
          </div>\`;
        }).join('');
      }
    }

    function renderProblemRows(problems) {
      return (problems || []).map(p => renderCfProblemRow(p, 'indent-2')).join('');
    }

    function renderCsesProblemRow(p, indentClass) {
      const escName = escapeHtml(p.name);
      const escCat = escapeHtml(p.category || '');
      const desc = p.solvedCount ? \`✓ \${p.solvedCount.toLocaleString()}\` : escCat;
      return \`<div class="tree-row \${indentClass}" onclick="openCsesProblem('\${p.taskId}', '\${escName.replace(/'/g, "\\\\'")}', '\${escCat.replace(/'/g, "\\\\'")}', '\${p.url || ''}')">
        <span class="status-slot"></span>
        <span class="tree-label">[\${p.taskId}] \${escName}</span>
        <span class="tree-description">\${desc}</span>
      </div>\`;
    }

    function renderCsesProblemRows(problems) {
      return (problems || []).map(p => renderCsesProblemRow(p, 'indent-2')).join('');
    }

    function loadMoreAll() {
      allCurrentOffset += 50;
      vscode.postMessage({ type: 'loadBucket', bucketType: 'all', offset: allCurrentOffset, limit: 50 });
    }

    function loadMoreCses() {
      csesCurrentOffset += 50;
      vscode.postMessage({ type: 'loadBucket', bucketType: 'cses', offset: csesCurrentOffset, limit: 50 });
    }

    // Populate bucket data received lazily from extension
    function onBucketDataReceived(data) {
      const { bucketType, key, problems, offset, hasMore, total } = data;
      const cacheKey = bucketType + ':' + key;

      if (bucketType === 'all') {
        const container = document.getElementById('ch_all');
        if (!container) return;
        if (!bucketCache['all']) bucketCache['all'] = [];
        bucketCache['all'].push(...problems);

        let html = bucketCache['all'].map(p => renderCfProblemRow(p, 'indent-1')).join('');

        if (hasMore) {
          html += \`<div class="load-more-row" onclick="loadMoreAll()">Load more problems (\${total - bucketCache['all'].length} remaining)...</div>\`;
        }
        container.innerHTML = html;
      } else if (bucketType === 'cses') {
        const container = document.getElementById('ch_cses-all');
        if (!container) return;
        if (!bucketCache['cses']) bucketCache['cses'] = [];
        bucketCache['cses'].push(...problems);

        let html = bucketCache['cses'].map(p => renderCsesProblemRow(p, 'indent-1')).join('');

        if (hasMore) {
          html += \`<div class="load-more-row" onclick="loadMoreCses()">Load more problems (\${total - bucketCache['cses'].length} remaining)...</div>\`;
        }
        container.innerHTML = html;
      } else {
        bucketCache[cacheKey] = problems;
        // Find which subch element matches this
        document.querySelectorAll('.tree-children').forEach(ch => {
          const id = ch.id;
          if (id.startsWith('subch_')) {
            const row = ch.previousElementSibling;
            if (row && row.getAttribute('onclick') && row.getAttribute('onclick').includes(key)) {
              if (bucketType === 'csesCat') {
                ch.innerHTML = renderCsesProblemRows(problems);
              } else {
                ch.innerHTML = renderProblemRows(problems);
              }
            }
          }
        });
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
        table.innerHTML = languages.map(lang => {
          const cmd = settings.compilers[lang] || '';
          return \`<tr>
            <td style="width: 45px; font-weight: 500; color: #aaa;">\${lang.toUpperCase()}:</td>
            <td><input type="text" value="\${escapeHtml(cmd)}" onchange="onCompilerChange('\${lang}', this.value)" /></td>
          </tr>\`;
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
          expandCategory(catId);
        });
      } else if (msg.type === 'bucketData') {
        onBucketDataReceived(msg);
      } else if (msg.type === 'settingsData') {
        populateSettings(msg.payload);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
