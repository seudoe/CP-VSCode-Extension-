import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class TestCasesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'seudoe.testCasesView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Initially update based on current active editor
    this.updateWebview(vscode.window.activeTextEditor);
    
    // Listen for editor changes
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.updateWebview(editor);
    });
  }

  private updateWebview(editor: vscode.TextEditor | undefined) {
    if (!this._view) { return; }

    const parsedTestCases = this.getSeudoeTestCases(editor);

    if (parsedTestCases) {
      this._view.webview.html = this.getHtmlForTestCases(parsedTestCases);
    } else {
      this._view.webview.html = this.getHtmlForEmptyState();
    }
  }

  private getSeudoeTestCases(editor: vscode.TextEditor | undefined): any | null {
    if (!editor) { return null; }
    
    const docPath = editor.document.uri.fsPath;
    const dir = path.dirname(docPath);
    const basenameWithoutExt = path.basename(docPath, path.extname(docPath));
    const seudoeFilePath = path.join(dir, '.seutest', `${basenameWithoutExt}.seudoe`);

    if (fs.existsSync(seudoeFilePath)) {
      try {
        const content = fs.readFileSync(seudoeFilePath, 'utf8');
        return JSON.parse(content);
      } catch (err) {
        console.error(`[seudoe] Failed to parse ${seudoeFilePath}:`, err);
      }
    }
    
    return null;
  }

  private getHtmlForEmptyState(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      padding: 10px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 90vh;
    }
    .btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      margin: 4px;
      cursor: pointer;
      width: 100%;
      box-sizing: border-box;
    }
    .btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <p>This document does not have a CPH problem associated with it.</p>
  <button class="btn">+ Create Problem</button>
  <button class="btn btn-secondary">? How to use this extension</button>
</body>
</html>`;
  }

  private getHtmlForTestCases(data: any): string {
    const testsHtml = (data.tests || []).map((t: any, i: number) => `
      <div class="test-case">
        <div class="tc-header">
          <span>TC ${i + 1}</span>
          <div class="tc-actions">
            <button class="icon-btn play">▶</button>
            <button class="icon-btn delete">🗑</button>
          </div>
        </div>
        <div class="tc-body">
          <label>Input:</label>
          <textarea readonly>${t.input || ''}</textarea>
          <label>Expected Output:</label>
          <textarea readonly>${t.output || ''}</textarea>
        </div>
      </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      padding: 0;
      margin: 0;
    }
    .header {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: bold;
    }
    .test-case {
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tc-header {
      padding: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--vscode-textLink-foreground);
      font-weight: bold;
      cursor: pointer;
    }
    .tc-actions .icon-btn {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 2px 4px;
    }
    .tc-actions .play { background: #4fb56b; color: #fff; }
    .tc-actions .delete { background: #f14c4c; color: #fff; }
    .tc-body {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 60px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      font-family: var(--vscode-editor-font-family);
      resize: vertical;
    }
    .btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      margin: 8px;
      cursor: pointer;
      width: calc(100% - 16px);
      box-sizing: border-box;
      font-weight: bold;
    }
    .btn:hover { background-color: var(--vscode-button-hoverBackground); }
    .btn-green { background-color: #4fb56b; }
    .btn-blue { background-color: #007acc; }
  </style>
</head>
<body>
  <div class="header">
    <span>Local: ${data.name || 'Unknown'}</span>
    <span style="color: #aaa">0 / ${data.tests?.length || 0} passed</span>
  </div>
  
  <div class="test-cases">
    ${testsHtml}
  </div>

  <button class="btn btn-green">+ New Testcase</button>
  <button class="btn btn-blue">Custom Checker</button>
  
  <div style="display:flex; padding: 0 8px;">
    <button class="btn btn-blue" style="margin: 4px;">Run All</button>
  </div>
</body>
</html>`;
  }
}
