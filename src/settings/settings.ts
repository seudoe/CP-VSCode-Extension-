import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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

export function getBoilerplate(extension: string, workspaceRoot: string, extensionUriPath: string): string {
  // Normalize extension (remove leading dot if present)
  const ext = extension.startsWith('.') ? extension.substring(1) : extension;
  
  const config = vscode.workspace.getConfiguration('seuCF');
  const customBoilerplates = config.get<any>('boilerplateCodes') || {};
  
  let errorPrefix = '';

  // 1. Check user custom boilerplate first
  if (customBoilerplates[ext]) {
    const val = customBoilerplates[ext];
    if (Array.isArray(val)) {
      return val.join('\n');
    } else if (typeof val === 'string' && val.startsWith('file:')) {
      const filePath = val.substring(5).trim(); // strip "file:"
      const resolvedPath = resolveDirectory(filePath, workspaceRoot);
      if (fs.existsSync(resolvedPath)) {
        try {
          return fs.readFileSync(resolvedPath, 'utf8');
        } catch (err) {
          console.error(`[seudoe] Failed to read boilerplate file: ${resolvedPath}`, err);
          errorPrefix = `// Error reading boilerplate file: ${err}\n// so loaded the default boilerplate\n\n`;
        }
      } else {
        errorPrefix = `// Error: Custom boilerplate file not found at ${resolvedPath}\n// so loaded the default boilerplate\n\n`;
      }
    } else if (typeof val === 'string') {
      return val;
    }
  }
  
  // 2. Load from default-boilerplates.json
  const defaultsPath = path.join(extensionUriPath, 'resources', 'default-boilerplates.json');
  if (fs.existsSync(defaultsPath)) {
    try {
      const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
      if (defaults[ext] && Array.isArray(defaults[ext])) {
        return errorPrefix + defaults[ext].join('\n');
      }
    } catch (err) {
      console.error('[seudoe] Failed to read default boilerplates', err);
    }
  }
  
  // Fallback if completely unknown
  return errorPrefix;
}
