import * as vscode from 'vscode';
import * as path from 'path';

export interface CodeNowSettings {
  directory: string;
  extension: string | undefined;
  filename: string;
}

export function getCodeNowSettings(): CodeNowSettings {
  const config = vscode.workspace.getConfiguration('seuCF');
  const dir = config.get<string>('fileCreationDirectory') || '';
  let ext: string | undefined = config.get<string>('defaultFileExtension') || 'Select everytime';
  const filename = config.get<string>('fileName') || '{problemId}-{problemName}{fileExtension}';

  if (ext === 'Select everytime' || ext === '') {
    ext = undefined;
  }

  return { directory: dir, extension: ext, filename };
}

export function resolveDirectory(rawDir: string, workspaceRoot: string): string {
  if (!rawDir) {
    return workspaceRoot;
  }
  
  // Check if it's an absolute path (Windows drive letter or Unix root)
  const isAbsolute = /^[a-zA-Z]:(\\|\/)/.test(rawDir) || /^\//.test(rawDir);
  
  if (isAbsolute) {
    return rawDir;
  } else {
    // Relative path
    return path.join(workspaceRoot, rawDir);
  }
}

export function generateFilename(
  template: string,
  variables: {
    problemId: string;
    contestId: string;
    problemIndex: string;
    problemName: string;
    fileExtension: string;
  }
): string {
  let name = template;
  name = name.replace(/{problemId}/g, variables.problemId);
  name = name.replace(/{contestId}/g, variables.contestId);
  name = name.replace(/{problemIndex}/g, variables.problemIndex);
  
  // Clean problem name to make it safe for file paths
  const safeName = variables.problemName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/ +/g, '-');
  name = name.replace(/{problemName}/g, safeName);
  
  name = name.replace(/{fileExtension}/g, variables.fileExtension);
  
  return name;
}
