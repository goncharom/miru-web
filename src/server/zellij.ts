import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PI_COMMAND, USER_SHELL } from './config';
import { delay } from './utils';

const execFileAsync = promisify(execFile);
let resolvedPiExecutablePromise: Promise<string> | undefined;

export async function createZellijSession(sessionName: string, cwd: string, tabName: string): Promise<void> {
  await execZellij(['attach', '--create-background', sessionName]);
  await delay(250);

  const piExecutable = await resolvePiExecutable();
  const shellArgs = getShellLaunchArgs(piExecutable);

  await execZellij([
    '--session',
    sessionName,
    'action',
    'new-tab',
    '-c',
    cwd,
    '-n',
    tabName,
    '--',
    ...shellArgs,
  ]);

  await delay(150);

  try {
    await execZellij(['--session', sessionName, 'action', 'close-tab-by-id', '0']);
  } catch {
    // Ignore. The default tab may already be gone.
  }
}

export async function killZellijSession(sessionName: string): Promise<void> {
  try {
    await execZellij(['kill-session', sessionName]);
  } catch {
    // Ignore missing sessions during cleanup.
  }
}

async function resolvePiExecutable(): Promise<string> {
  if (!resolvedPiExecutablePromise) {
    resolvedPiExecutablePromise = findExecutable(PI_COMMAND);
  }
  return resolvedPiExecutablePromise;
}

async function findExecutable(command: string): Promise<string> {
  if (command.includes(' ')) {
    throw new Error('PI_COMMAND must be a single executable path or name');
  }

  if (isAbsolute(command) || command.startsWith('./') || command.startsWith('../')) {
    await ensureExecutable(command);
    return command;
  }

  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      await ensureExecutable(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }

  throw new Error(`Could not resolve executable: ${command}`);
}

async function ensureExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
}

function getShellLaunchArgs(piExecutable: string): string[] {
  const shell = USER_SHELL;
  const loginFlag = shell.endsWith('zsh') || shell.endsWith('bash') ? '-ilc' : '-lc';
  return [shell, loginFlag, `exec ${shellQuote(piExecutable)}`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function execZellij(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('zellij', args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });

  const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
  return output;
}
