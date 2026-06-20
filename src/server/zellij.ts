import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import * as pty from 'node-pty';
import { promisify } from 'node:util';
import type {
  AttachSessionOptions,
  CreateSessionRequest,
  DiscoveredSession,
  SessionBackend,
} from './agents';
import { delay, parseAgentIdFromSessionName } from './utils';

interface ZellijPaneInfo {
  is_plugin: boolean;
  exited: boolean;
  exit_status: number | null;
  tab_name: string;
  pane_cwd?: string;
}

export interface ZellijBackendOptions {
  zellijExecutable?: string;
  userShell: string;
}

const execFileAsync = promisify(execFile);

export class ZellijBackend implements SessionBackend {
  private readonly zellijExecutable: string;
  private readonly userShell: string;

  constructor(options: ZellijBackendOptions) {
    this.zellijExecutable = options.zellijExecutable ?? 'zellij';
    this.userShell = options.userShell;
  }

  async createSession(input: CreateSessionRequest): Promise<DiscoveredSession> {
    await this.execZellij(['attach', '--create-background', input.sessionName]);
    await delay(250);

    const launchCommand = await resolveLaunchCommand(input.launchCommand);
    const shellArgs = getShellLaunchArgs(this.userShell, launchCommand);

    await this.execZellij([
      '--session',
      input.sessionName,
      'action',
      'new-tab',
      '-c',
      input.cwd,
      '-n',
      input.name,
      '--',
      ...shellArgs,
    ]);

    await delay(150);

    try {
      await this.execZellij(['--session', input.sessionName, 'action', 'close-tab-by-id', '0']);
    } catch {
      // Ignore. The default tab may already be gone.
    }

    return {
      agentId: input.agentId,
      sessionName: input.sessionName,
      name: input.name,
      cwd: input.cwd,
      lastExitCode: null,
      running: true,
    };
  }

  attach(session: DiscoveredSession, options: AttachSessionOptions): pty.IPty {
    return pty.spawn(this.zellijExecutable, ['attach', session.sessionName], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: session.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await this.execZellij(['kill-session', sessionName]);
    } catch {
      // Ignore missing sessions during cleanup.
    }
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    const stdout = await this.execZellij(['list-sessions', '--short']);
    const sessionNames = stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    const discovered: DiscoveredSession[] = [];

    for (const sessionName of sessionNames) {
      const agentId = parseAgentIdFromSessionName(sessionName);
      if (!agentId) continue;

      const session = await this.inspectMiruSession(sessionName, agentId);
      if (session) {
        discovered.push(session);
      }
    }

    return discovered;
  }

  private async inspectMiruSession(sessionName: string, agentId: string): Promise<DiscoveredSession | undefined> {
    try {
      const output = await this.execZellij(['--session', sessionName, 'action', 'list-panes', '--json', '-a', '-c', '-s', '-t']);
      const panes = JSON.parse(output) as ZellijPaneInfo[];
      const mainPane = panes.find((pane) => !pane.is_plugin && typeof pane.pane_cwd === 'string');
      if (!mainPane?.pane_cwd) {
        return undefined;
      }

      return {
        agentId,
        sessionName,
        name: mainPane.tab_name || sessionName,
        cwd: mainPane.pane_cwd,
        lastExitCode: mainPane.exit_status ?? null,
        running: !mainPane.exited,
      };
    } catch {
      return undefined;
    }
  }

  private async execZellij(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync(this.zellijExecutable, args, {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });

    return `${stdout ?? ''}${stderr ?? ''}`.trim();
  }
}

async function resolveLaunchCommand(argv: string[]): Promise<string[]> {
  if (argv.length === 0) {
    throw new Error('Launch command is required');
  }

  const [command, ...rest] = argv;
  const resolved = await findExecutable(command);
  return [resolved, ...rest];
}

async function findExecutable(command: string): Promise<string> {
  if (!command.trim()) {
    throw new Error('Launch command is required');
  }

  if (isAbsolute(command) || command.startsWith('./') || command.startsWith('../') || command.includes('/')) {
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

function getShellLaunchArgs(userShell: string, launchCommand: string[]): string[] {
  const loginFlag = userShell.endsWith('zsh') || userShell.endsWith('bash') ? '-ilc' : '-lc';
  return [userShell, loginFlag, `exec ${shellJoinArgs(launchCommand)}`];
}

function shellJoinArgs(values: string[]): string {
  return values.map((value) => shellQuote(value)).join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
