import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIRU_AGENT_STATE_DIR = resolve(homedir(), '.miru-web', 'agents');
const MIRU_ARTIFACT_IGNORE_PATTERN = '.miru/';

export interface ManagedWorktreeInfo {
  agentId: string;
  branchName: string;
  repoRoot: string;
  worktreePath: string;
}

export interface CreatedManagedWorktree extends ManagedWorktreeInfo {
  launchCwd: string;
}

interface GitCheckoutInfo {
  checkoutRoot: string;
  gitDir: string;
  commonDir: string;
  repoRoot: string;
  isLinkedWorktree: boolean;
}

export async function createManagedWorktree(agentId: string, cwd: string, branchName: string): Promise<CreatedManagedWorktree> {
  const name = branchName.trim();
  if (!name) {
    throw new Error('Branch / workspace name is required');
  }

  const checkout = await inspectGitCheckout(cwd);
  if (!checkout) {
    throw new Error('Folder is not inside a git repository');
  }

  await ensureMiruArtifactsIgnored(checkout.commonDir);

  const relativeCwd = relative(checkout.checkoutRoot, cwd);
  const worktreePath = resolve(checkout.repoRoot, '..', `${basename(checkout.repoRoot)}--${sanitizeWorktreePathPart(name)}`);

  await execGit(checkout.repoRoot, ['worktree', 'add', '-b', name, worktreePath, 'HEAD']);

  const info: CreatedManagedWorktree = {
    agentId,
    branchName: name,
    repoRoot: checkout.repoRoot,
    worktreePath,
    launchCwd: relativeCwd && relativeCwd !== '.' ? resolve(worktreePath, relativeCwd) : worktreePath,
  };

  await saveManagedWorktreeInfo(info);
  return info;
}

export async function removeManagedWorktree(info: ManagedWorktreeInfo): Promise<void> {
  await execGit(info.repoRoot, ['worktree', 'remove', info.worktreePath]);
}

export async function loadManagedWorktreeInfo(agentId: string): Promise<ManagedWorktreeInfo | null> {
  try {
    const raw = await fs.readFile(agentStatePath(agentId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ManagedWorktreeInfo>;
    if (
      typeof parsed.agentId !== 'string' ||
      typeof parsed.branchName !== 'string' ||
      typeof parsed.repoRoot !== 'string' ||
      typeof parsed.worktreePath !== 'string'
    ) {
      return null;
    }
    return {
      agentId: parsed.agentId,
      branchName: parsed.branchName,
      repoRoot: parsed.repoRoot,
      worktreePath: parsed.worktreePath,
    };
  } catch {
    return null;
  }
}

export async function deleteManagedWorktreeInfo(agentId: string): Promise<void> {
  try {
    await fs.unlink(agentStatePath(agentId));
  } catch {
    // Ignore missing state.
  }
}

async function saveManagedWorktreeInfo(info: ManagedWorktreeInfo): Promise<void> {
  await fs.mkdir(MIRU_AGENT_STATE_DIR, { recursive: true });
  await fs.writeFile(agentStatePath(info.agentId), JSON.stringify(info, null, 2), 'utf8');
}

function agentStatePath(agentId: string): string {
  return resolve(MIRU_AGENT_STATE_DIR, `${agentId}.json`);
}

async function inspectGitCheckout(cwd: string): Promise<GitCheckoutInfo | null> {
  try {
    const output = await execGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    const lines = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    const [checkoutRoot, gitDir, commonDir] = lines;
    if (!checkoutRoot || !gitDir || !commonDir) {
      return null;
    }

    return {
      checkoutRoot,
      gitDir,
      commonDir,
      repoRoot: dirname(commonDir),
      isLinkedWorktree: gitDir !== commonDir,
    };
  } catch {
    return null;
  }
}

async function ensureMiruArtifactsIgnored(commonDir: string): Promise<void> {
  const excludePath = resolve(commonDir, 'info', 'exclude');
  let current = '';

  try {
    current = await fs.readFile(excludePath, 'utf8');
  } catch {
    // Ignore missing exclude file.
  }

  const lines = current
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(MIRU_ARTIFACT_IGNORE_PATTERN)) {
    return;
  }

  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await fs.mkdir(dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, `${current}${prefix}${MIRU_ARTIFACT_IGNORE_PATTERN}\n`, 'utf8');
}

function sanitizeWorktreePathPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'workspace';
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });

  return `${stdout ?? ''}${stderr ?? ''}`.trim();
}
