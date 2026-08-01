import * as vscode from 'vscode';

// ── Problems Tree ────────────────────────────────────────────────────────────

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
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'problemCategory';
  }
}

class ProblemsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      // Root — return all category nodes
      return PROBLEM_CATEGORIES.map(label => new ProblemCategoryItem(label));
    }
    // Children for each category will be populated later
    return [];
  }
}

// ── Test Cases Tree (placeholder) ───────────────────────────────────────────

class TestCasesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    const placeholder = new vscode.TreeItem('No problem selected');
    placeholder.description = 'Open a problem to see test cases';
    return [placeholder];
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "seudoe" is now active!');

  vscode.window.registerTreeDataProvider('seudoe.problemsView', new ProblemsProvider());
  vscode.window.registerTreeDataProvider('seudoe.testCasesView', new TestCasesProvider());

  const disposable = vscode.commands.registerCommand('seudoe.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from codFrc!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
