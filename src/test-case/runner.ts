import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

interface RunCommand {
  compile?: string[];
  run: string[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timeMs: number;
  error?: string;
}

export async function getRunCommand(extension: string, extensionUriPath: string): Promise<RunCommand | null> {
  const ext = extension.startsWith('.') ? extension.substring(1) : extension;
  const configPath = path.join(extensionUriPath, 'resources', 'run-commands.json');
  
  if (!fs.existsSync(configPath)) return null;
  
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const langData = data[ext];
    if (!langData) return null;
    
    let platformKey = process.platform === 'win32' ? 'win32' : (process.platform === 'darwin' ? 'darwin' : 'linux');
    const platformData = langData[platformKey] || langData['linux'] || langData['win32'];
    
    if (!platformData) return null;

    const config = vscode.workspace.getConfiguration('seuCF');
    const compilers = config.get<Record<string, string>>('compilers') || {};
    let compiler = compilers[ext];
    
    if (compiler && platformData[compiler]) {
      return platformData[compiler];
    }
    
    // Fallback to first available compiler for this platform
    const fallbackCompiler = Object.keys(platformData)[0];
    if (fallbackCompiler) {
      return platformData[fallbackCompiler];
    }

    return null;
  } catch (e) {
    console.error('[seudoe] Failed to parse run-commands.json', e);
    return null;
  }
}

function resolveCommand(cmdArray: string[], sourcePath: string): string[] {
  const sourceDir = path.dirname(sourcePath);
  const seutestDir = path.join(sourceDir, '.seutest');
  const basenameWithoutExt = path.basename(sourcePath, path.extname(sourcePath));
  
  const binaryPath = path.join(seutestDir, basenameWithoutExt);
  
  return cmdArray.map(arg => {
    let resolved = arg.replace(/{source}/g, sourcePath);
    resolved = resolved.replace(/{binary}/g, binaryPath);
    resolved = resolved.replace(/{binary_dir}/g, seutestDir);
    resolved = resolved.replace(/{source_dir}/g, sourceDir);
    return resolved;
  });
}

export async function compile(sourcePath: string, cmdTemplate: string[], abortSignal?: AbortSignal): Promise<{ success: boolean; output: string }> {
  const resolvedArgs = resolveCommand(cmdTemplate, sourcePath);
  const command = resolvedArgs[0];
  const args = resolvedArgs.slice(1);
  
  return new Promise((resolve) => {
    let output = '';
    const child = child_process.spawn(command, args, { cwd: path.dirname(sourcePath) });
    
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        child.kill();
        resolve({ success: false, output: output + '\n[Process Interrupted]' });
      });
    }
    
    child.stdout.on('data', (d) => output += d.toString());
    child.stderr.on('data', (d) => output += d.toString());
    
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, output: output || `Compilation failed with exit code ${code}` });
      } else {
        resolve({ success: true, output: output });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, output: `Failed to spawn compiler: ${err.message}` });
    });
  });
}

export async function runTestCase(
  sourcePath: string, 
  cmdTemplate: string[], 
  input: string, 
  timeLimitMs: number,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  const resolvedArgs = resolveCommand(cmdTemplate, sourcePath);
  let command = resolvedArgs[0];
  const args = resolvedArgs.slice(1);

  if (path.isAbsolute(command)) {
    command = path.resolve(command);
  }

  if (process.platform === 'win32' && !command.endsWith('.exe') && !command.endsWith('.bat') && !command.endsWith('.cmd')) {
    if (fs.existsSync(command + '.exe')) {
      command += '.exe';
    }
  }
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutData = '';
    let stderrData = '';
    
    const child = child_process.spawn(command, args, {
      cwd: path.dirname(sourcePath)
    });

    let isAborted = false;
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        isAborted = true;
        child.kill();
      });
    }

    let isTimeout = false;
    const timer = setTimeout(() => {
      isTimeout = true;
      child.kill('SIGKILL');
    }, timeLimitMs);

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const timeMs = Date.now() - startTime;
      
      let errorMsg = undefined;
      if (isAborted) {
        errorMsg = `Process Interrupted`;
      } else if (isTimeout) {
        errorMsg = `Time Limit Exceeded (${timeLimitMs}ms)`;
      } else if (code !== 0) {
        errorMsg = `Runtime Error (Exit code ${code})`;
      }

      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        code,
        timeMs,
        error: errorMsg
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        code: -1,
        timeMs: Date.now() - startTime,
        error: `Execution Failed: ${err.message}`
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
