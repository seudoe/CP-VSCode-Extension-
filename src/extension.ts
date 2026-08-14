import * as vscode from 'vscode';
import { initDb, isUpToDate, refreshDb, ensureDerivedDbs } from './problems/load-db';
import { CFProblem } from './problems/cf-api';
import { closeDb } from './problems/db';
import { saveUserDetails, fetchUserStatus, initUserDb } from './problems/user-db';
import { ContestWithProblems } from './problems/contest-db';

import { ProblemsProvider, RatingDecorationProvider, openProblemPanel } from './problems/problems-view';
import { TestCasesViewProvider } from './test-case/testcases-view';

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "seudoe" is now active!');

  // Save DB files into extension's global storage path
  const dbStoragePath = context.extensionPath;
  initDb(dbStoragePath);
  initUserDb(dbStoragePath);

  const problemsProvider = new ProblemsProvider(context);
  const problemsTreeView = vscode.window.createTreeView('seudoe.problemsView', {
    treeDataProvider: problemsProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(problemsTreeView);
  
  const testCasesProvider = new TestCasesViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TestCasesViewProvider.viewType, testCasesProvider)
  );

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new RatingDecorationProvider())
  );

  // Open problem on click
  context.subscriptions.push(
    vscode.commands.registerCommand('seudoe.openProblem', (problem: CFProblem) => {
      openProblemPanel(problem, context);
    })
  );

  // Set user handle
  context.subscriptions.push(
    vscode.commands.registerCommand('seudoe.setUserHandle', async () => {
      const handle = await vscode.window.showInputBox({
        prompt: 'Enter your Codeforces handle to fetch submissions',
        placeHolder: 'e.g. tourist'
      });
      if (!handle) return;

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Fetching submissions for ${handle}...`,
        cancellable: false
      }, async () => {
        try {
          const details = await fetchUserStatus(handle);
          saveUserDetails(details);
          problemsProvider.setUserDetails(details);
          vscode.window.showInformationMessage(`Successfully loaded submission status for ${handle}!`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to load user: ${err.message}`);
        }
      });
    })
  );

  syncProblems(problemsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('seudoe.helloWorld', () => {
      vscode.window.showInformationMessage('Hello World from codFrc!');
    })
  );

  // Search Problems
  context.subscriptions.push(
    vscode.commands.registerCommand('seudoe.searchProblems', () => {
      const allProblems = problemsProvider.getProblems();
      const contestsDb = problemsProvider.getContests();

      if (allProblems.length === 0) {
        vscode.window.showInformationMessage('Problems are still loading...');
        return;
      }

      const contestMap = new Map<number, string>();
      for (const c of contestsDb.past) contestMap.set(c.contest.id, c.contest.name);
      for (const c of contestsDb.upcoming) contestMap.set(c.contest.id, c.contest.name);

      interface ProblemQuickPickItem extends vscode.QuickPickItem {
        problem: CFProblem;
      }

      const items: ProblemQuickPickItem[] = allProblems.map(p => {
        const id = p.contestId ? `${p.contestId}${p.index}` : p.index;
        const contestName = p.contestId ? (contestMap.get(p.contestId) ?? `Contest ${p.contestId}`) : 'Unknown Contest';
        return {
          label: `[${id}] ${p.name}`,
          description: p.rating ? `★ ${p.rating}` : '★ ?',
          detail: contestName,
          problem: p,
        };
      });

      const quickPick = vscode.window.createQuickPick<ProblemQuickPickItem>();
      quickPick.items = items;
      quickPick.placeholder = 'Search Codeforces problems (e.g. 1543A, Two Sum, Div. 2...)';
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;

      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
          openProblemPanel(selected.problem, context);
          quickPick.hide();
        }
      });

      quickPick.onDidHide(() => quickPick.dispose());
      quickPick.show();
    })
  );

  // Search Past Contests
  context.subscriptions.push(
    vscode.commands.registerCommand('seudoe.searchPastContests', () => {
      const contestsDb = problemsProvider.getContests();
      if (contestsDb.past.length === 0) {
        vscode.window.showInformationMessage('Contests are still loading...');
        return;
      }

      interface ContestQuickPickItem extends vscode.QuickPickItem {
        contestEntry: ContestWithProblems;
      }

      const items: ContestQuickPickItem[] = contestsDb.past.map((entry: ContestWithProblems) => {
        const idPad = String(entry.contest.id).padStart(4, '0');
        return {
          label: `${idPad} - ${entry.contest.name}`,
          description: `${entry.problems.length} problems`,
          contestEntry: entry,
        };
      });

      const quickPick = vscode.window.createQuickPick<ContestQuickPickItem>();
      quickPick.items = items;
      quickPick.placeholder = 'Search Past Contests...';
      quickPick.matchOnDescription = true;

      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
          quickPick.hide();
          
          // Open a second quick pick for the problems in this contest
          interface ProblemQuickPickItem extends vscode.QuickPickItem {
            problem: CFProblem;
          }
          
          const probItems: ProblemQuickPickItem[] = selected.contestEntry.problems.map((p: CFProblem) => {
            const id = p.contestId ? `${p.contestId}${p.index}` : p.index;
            return {
              label: `[${id}] ${p.name}`,
              description: p.rating ? `★ ${p.rating}` : '★ ?',
              detail: selected.contestEntry.contest.name,
              problem: p,
            };
          });

          const probQuickPick = vscode.window.createQuickPick<ProblemQuickPickItem>();
          probQuickPick.items = probItems;
          probQuickPick.placeholder = `Select a problem from ${selected.contestEntry.contest.name}`;
          probQuickPick.matchOnDescription = true;
          
          probQuickPick.onDidAccept(() => {
            const selectedProb = probQuickPick.selectedItems[0];
            if (selectedProb) {
              openProblemPanel(selectedProb.problem, context);
              probQuickPick.hide();
            }
          });
          probQuickPick.onDidHide(() => probQuickPick.dispose());
          probQuickPick.show();
        }
      });

      quickPick.onDidHide(() => quickPick.dispose());
      quickPick.show();
    })
  );
}

async function syncProblems(provider: ProblemsProvider): Promise<void> {
  if (isUpToDate()) {
    console.log('[seudoe] Problems DB is up to date, skipping problems API call.');
    // Still ensure contests are loaded (fetched once if missing)
    const contests = await ensureDerivedDbs();
    provider.setContestDb(contests);
    return;
  }

  console.log('[seudoe] Fetching problems + contests from Codeforces API...');
  try {
    const { problems, contests } = await refreshDb();
    provider.refresh(problems, contests);
    console.log(`[seudoe] Loaded ${problems.length} problems, ${contests.past.length} past contests, ${contests.upcoming.length} upcoming.`);
  } catch (err) {
    console.error('[seudoe] Failed to fetch data:', err);
  }
}

export function deactivate() {
  closeDb().catch(console.error);
}
