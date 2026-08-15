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

    webviewView.webview.onDidReceiveMessage(message => {
      this.handleMessage(message);
    });

    // Initially update based on current active editor
    this.updateWebview(vscode.window.activeTextEditor);
    
    // Listen for editor changes
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.updateWebview(editor);
    });
  }

  private handleMessage(message: any) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const docPath = editor.document.uri.fsPath;
    const dir = path.dirname(docPath);
    const basenameWithoutExt = path.basename(docPath, path.extname(docPath));
    const seutestDir = path.join(dir, '.seutest');
    const seudoeFilePath = path.join(seutestDir, `${basenameWithoutExt}.seudoe`);

    switch (message.type) {
      case 'createProblem': {
        const ext = path.extname(docPath).toLowerCase();
        const allowedExtensions = [
          '.c', '.cpp', '.cxx', '.cc', '.cs', '.d', '.fs', '.go', '.hs', 
          '.java', '.kt', '.ml', '.pas', '.dpr', '.php', '.py', '.rb', 
          '.rs', '.scala', '.js', '.tcl', '.io', '.pike', '.bf', '.b', 
          '.cob', '.cbl', '.factor', '.adb', '.ads', '.pi', '.qs', '.txt'
        ];
        
        if (!allowedExtensions.includes(ext)) {
          vscode.window.showErrorMessage(`Cannot create problem: File extension '${ext}' is not supported by Codeforces.`);
          break;
        }

        if (!fs.existsSync(seutestDir)) {
          fs.mkdirSync(seutestDir, { recursive: true });
        }
        const boilerplate = {
          name: `Local: ${basenameWithoutExt}`,
          url: docPath,
          tests: [],
          interactive: false,
          memoryLimit: 1024,
          timeLimit: 3000,
          srcPath: docPath,
          group: 'local',
          local: true
        };
        fs.writeFileSync(seudoeFilePath, JSON.stringify(boilerplate, null, 2), 'utf8');
        this.updateWebview(editor);
        break;
      }

      case 'addTestCase':
        if (fs.existsSync(seudoeFilePath)) {
          try {
            const data = JSON.parse(fs.readFileSync(seudoeFilePath, 'utf8'));
            data.tests = data.tests || [];
            data.tests.push({
              id: Date.now(),
              input: '',
              output: '',
              answer: ''
            });
            fs.writeFileSync(seudoeFilePath, JSON.stringify(data, null, 2), 'utf8');
            this.updateWebview(editor);
          } catch (e) {
            console.error(e);
          }
        }
        break;

      case 'updateTestCase':
        if (fs.existsSync(seudoeFilePath)) {
          try {
            const data = JSON.parse(fs.readFileSync(seudoeFilePath, 'utf8'));
            data.tests = message.tests;
            fs.writeFileSync(seudoeFilePath, JSON.stringify(data, null, 2), 'utf8');
            // Deliberately NOT calling updateWebview here so we don't steal focus from the textarea
          } catch (e) {
            console.error(e);
          }
        }
        break;
    }
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
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 90vh;
      box-sizing: border-box;
    }
    p {
      font-size: 14px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
      max-width: 250px;
    }
    .btn {
      background: linear-gradient(135deg, var(--vscode-button-background), #005999);
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 10px 16px;
      margin: 6px 0;
      cursor: pointer;
      width: 100%;
      max-width: 200px;
      font-weight: 600;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      transition: all 0.2s ease;
      box-sizing: border-box;
    }
    .btn:hover {
      background-color: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
    }
    .btn:active {
      transform: translateY(1px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .btn-secondary {
      background: transparent;
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-secondaryBackground);
      box-shadow: none;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
  </style>
</head>
<body>
  <p>This document does not have a CPH problem associated with it.</p>
  <button class="btn" id="create-btn">+ Create Problem</button>
  <button class="btn btn-secondary">? How to use this extension</button>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('create-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'createProblem' });
    });
  </script>
</body>
</html>`;
  }

  private getHtmlForTestCases(data: any): string {
    const testsHtml = (data.tests || []).map((t: any, i: number) => {
      const getRows = (text: string) => Math.min(25, Math.max(2, (text || '').split('\n').length));
      return `
      <div class="test-case" data-index="${i}">
        <div class="tc-header">
          <span>TC ${i + 1}</span>
          <div class="tc-actions">
            <button class="icon-btn play">▶</button>
            <button class="icon-btn delete">🗑</button>
          </div>
        </div>
        <div class="tc-body">
          <label>Input:</label>
          <textarea class="tc-input" rows="${getRows(t.input)}">${t.input || ''}</textarea>
          <label>Expected Output:</label>
          <textarea class="tc-answer" rows="${getRows(t.answer)}">${t.answer || ''}</textarea>
          ${t.output ? `
          <label>Output:</label>
          <textarea class="tc-output" readonly rows="${getRows(t.output)}">${t.output}</textarea>
          ` : ''}
        </div>
      </div>
    `;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      margin: 0;
    }
    .header {
      padding: 12px 16px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .test-case {
      margin: 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      transition: border-color 0.2s ease;
    }
    .test-case:hover {
      border-color: var(--vscode-focusBorder);
    }
    .tc-header {
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--vscode-editor-foreground);
      font-weight: 600;
      font-size: 12px;
    }
    .tc-actions {
      display: flex;
      gap: 6px;
    }
    .tc-actions .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-icon-foreground);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tc-actions .play:hover { background: rgba(79, 181, 107, 0.2); color: #4fb56b; }
    .tc-actions .delete:hover { background: rgba(241, 76, 76, 0.2); color: #f14c4c; }
    .tc-body {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      background-color: rgba(0, 0, 0, 0.2);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
      line-height: 1.4;
      resize: vertical;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
    }
    textarea[readonly] {
      background-color: rgba(0, 0, 0, 0.4);
      opacity: 0.8;
      cursor: not-allowed;
    }
    .actions-container {
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .actions-row {
      display: flex;
      gap: 10px;
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 10px;
      cursor: pointer;
      flex: 1;
      font-weight: 600;
      font-size: 12px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    }
    .btn:active {
      transform: translateY(1px);
      box-shadow: none;
    }
    .btn-green {
      background: linear-gradient(135deg, #4fb56b, #3b9152);
      color: #fff;
    }
    .btn-green:hover { background: linear-gradient(135deg, #59c578, #44a55d); }
    .btn-blue {
      background: linear-gradient(135deg, #007acc, #005a9e);
      color: #fff;
    }
    .btn-blue:hover { background: linear-gradient(135deg, #0088e5, #006bbd); }
  </style>
</head>
<body>
  <div class="header">
    <span>${data.name || 'Unknown'}</span>
    <span style="color: #aaa">0 / ${data.tests?.length || 0} passed</span>
  </div>
  
  <div class="test-cases">
    ${testsHtml}
  </div>

  <div class="actions-container">
    <div class="actions-row">
      <button class="btn btn-green" id="new-testcase-btn">+ New Testcase</button>
      <button class="btn btn-blue">Custom Checker</button>
    </div>
    <button class="btn btn-blue" style="width: 100%;">Run All</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    let tests = ${JSON.stringify(data.tests || [])};

    document.getElementById('new-testcase-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'addTestCase' });
    });

    const testCaseDivs = document.querySelectorAll('.test-case');
    testCaseDivs.forEach((div, index) => {
      const inputEl = div.querySelector('.tc-input');
      const answerEl = div.querySelector('.tc-answer');

      const save = () => {
        if (inputEl) tests[index].input = inputEl.value;
        if (answerEl) tests[index].answer = answerEl.value;
        vscode.postMessage({ type: 'updateTestCase', tests });
      };

      if (inputEl) inputEl.addEventListener('input', save);
      if (answerEl) answerEl.addEventListener('input', save);
    });
  </script>
</body>
</html>`;
  }
}
