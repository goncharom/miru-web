import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type * as pty from 'node-pty';
import type { AgentSummary, CreateAgentInput } from '../shared/protocol';
import { TerminalSession } from './terminal';
import { defaultAgentName, folderTagFromCwd, makeAgentId, makeSessionName, validateDirectory } from './utils';

export interface DiscoveredSession {
  agentId: string;
  sessionName: string;
  name: string;
  cwd: string;
  lastExitCode: number | null;
  running: boolean;
}

export interface CreateSessionRequest {
  agentId: string;
  sessionName: string;
  name: string;
  cwd: string;
  launchCommand: string[];
}

export interface AttachSessionOptions {
  cols: number;
  rows: number;
}

export interface SessionBackend {
  createSession(input: CreateSessionRequest): Promise<DiscoveredSession>;
  discoverSessions(): Promise<DiscoveredSession[]>;
  attach(session: DiscoveredSession, options: AttachSessionOptions): pty.IPty;
  killSession(sessionName: string): Promise<void>;
}

export interface PreparedWorkspace {
  launchCwd: string;
  metadata?: unknown;
}

export interface PrepareWorkspaceInput {
  agentId: string;
  cwd: string;
  workspaceName?: string;
}

export interface WorkspaceProvider {
  canPrepare(input: CreateAgentInput): boolean;
  prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace>;
  recover(agentId: string, sessionCwd: string): Promise<PreparedWorkspace | null>;
  cleanup(workspace: PreparedWorkspace): Promise<void>;
}

interface WorkspaceHandle {
  provider: WorkspaceProvider;
  prepared: PreparedWorkspace;
}

interface AgentRecord {
  id: string;
  name: string;
  cwd: string;
  folderTag: string;
  sessionName: string;
  status: AgentSummary['status'];
  createdAt: number;
  updatedAt: number;
  lastExitCode: number | null;
  terminal: TerminalSession;
  deleting: boolean;
  detaching: boolean;
  suppressedTerminalExitCount: number;
  workspace: WorkspaceHandle | null;
}

export interface AgentsEvents {
  agentsChanged: (agents: AgentSummary[]) => void;
  terminalData: (agentId: string, data: string) => void;
  terminalExit: (agentId: string, exitCode: number | null) => void;
  clipboardCopy: (agentId: string, text: string) => void;
}

export interface AgentManagerOptions {
  sessionBackend: SessionBackend;
  workspaceProviders: WorkspaceProvider[];
  launchCommand: string[];
  initialCols: number;
  initialRows: number;
  terminalBufferLimit: number;
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly sessionBackend: SessionBackend;
  private readonly workspaceProviders: WorkspaceProvider[];
  private readonly launchCommand: string[];
  private readonly initialCols: number;
  private readonly initialRows: number;
  private readonly terminalBufferLimit: number;

  constructor(options: AgentManagerOptions) {
    super();
    this.sessionBackend = options.sessionBackend;
    this.workspaceProviders = options.workspaceProviders;
    this.launchCommand = [...options.launchCommand];
    this.initialCols = options.initialCols;
    this.initialRows = options.initialRows;
    this.terminalBufferLimit = options.terminalBufferLimit;
  }

  list(): AgentSummary[] {
    return Array.from(this.agents.values())
      .map((agent) => this.toSummary(agent))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getSummary(agentId: string): AgentSummary | undefined {
    const agent = this.agents.get(agentId);
    return agent ? this.toSummary(agent) : undefined;
  }

  getCwd(agentId: string): string | undefined {
    return this.agents.get(agentId)?.cwd;
  }

  getBuffer(agentId: string): string {
    return this.requireAgent(agentId).terminal.getBuffer();
  }

  async restoreExisting(): Promise<void> {
    const discovered = await this.sessionBackend.discoverSessions();
    let index = 0;

    for (const session of discovered) {
      if (this.agents.has(session.agentId)) continue;
      const workspace = await this.recoverWorkspace(session.agentId, session.cwd);
      await this.attachDiscoveredSession(session, Date.now() + index, workspace);
      index += 1;
    }

    this.emitAgentsChanged();
  }

  async create(input: CreateAgentInput): Promise<AgentSummary> {
    const cwd = resolve(input.cwd.trim());
    await validateDirectory(cwd);

    const id = makeAgentId();
    const name = (input.name?.trim() || defaultAgentName(cwd)).slice(0, 80);
    const sessionName = makeSessionName(id);
    const workspaceName = input.workspaceName?.trim() || undefined;
    const normalizedInput: CreateAgentInput = {
      cwd,
      name,
      workspaceName,
    };

    const provider = this.selectWorkspaceProvider(normalizedInput);
    let workspace: WorkspaceHandle | null = null;
    let createdSession: DiscoveredSession | null = null;

    try {
      const prepared = await provider.prepare({
        agentId: id,
        cwd,
        workspaceName,
      });
      workspace = { provider, prepared };

      createdSession = await this.sessionBackend.createSession({
        agentId: id,
        sessionName,
        name,
        cwd: prepared.launchCwd,
        launchCommand: this.launchCommand,
      });

      const agent = await this.attachDiscoveredSession(createdSession, Date.now(), workspace);
      this.emitAgentsChanged();
      return this.toSummary(agent);
    } catch (error) {
      if (createdSession) {
        await this.sessionBackend.killSession(createdSession.sessionName);
      } else {
        await this.sessionBackend.killSession(sessionName);
      }
      if (workspace) {
        try {
          await workspace.provider.cleanup(workspace.prepared);
        } catch {
          // ignore cleanup errors
        }
      }
      throw error;
    }
  }

  write(agentId: string, data: string | Buffer): void {
    const agent = this.requireAgent(agentId);
    agent.terminal.write(data);
    agent.updatedAt = Date.now();
  }

  resize(agentId: string, cols: number, rows: number): void {
    const agent = this.requireAgent(agentId);
    agent.terminal.resize(cols, rows);
    agent.updatedAt = Date.now();
  }

  async refreshTerminal(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const previousTerminal = agent.terminal;
    const session: DiscoveredSession = {
      agentId: agent.id,
      sessionName: agent.sessionName,
      name: agent.name,
      cwd: agent.cwd,
      lastExitCode: agent.lastExitCode,
      running: agent.status === 'running' || agent.status === 'starting',
    };

    agent.suppressedTerminalExitCount += 1;
    try {
      previousTerminal.kill();
    } catch {
      agent.suppressedTerminalExitCount = Math.max(0, agent.suppressedTerminalExitCount - 1);
    }

    const ptyProcess = this.sessionBackend.attach(session, {
      cols: this.initialCols,
      rows: this.initialRows,
    });

    agent.terminal = new TerminalSession(
      ptyProcess,
      {
        onData: (data) => {
          agent.updatedAt = Date.now();
          this.emit('terminalData', agent.id, data);
        },
        onClipboardCopy: (text) => {
          agent.updatedAt = Date.now();
          this.emit('clipboardCopy', agent.id, text);
        },
        onExit: (exitCode) => {
          if (agent.suppressedTerminalExitCount > 0) {
            agent.suppressedTerminalExitCount -= 1;
            return;
          }
          agent.updatedAt = Date.now();
          agent.lastExitCode = exitCode;
          if (!agent.deleting && !agent.detaching) {
            agent.status = exitCode === 0 ? 'exited' : 'error';
          }
          this.emit('terminalExit', agent.id, exitCode);
          if (!agent.detaching) {
            this.emitAgentsChanged();
          }
        },
      },
      { bufferLimit: this.terminalBufferLimit },
    );

    agent.updatedAt = Date.now();
  }

  async delete(agentId: string): Promise<string | undefined> {
    const agent = this.requireAgent(agentId);
    agent.deleting = true;

    try {
      agent.terminal.kill();
    } catch {
      // ignore
    }

    let warning: string | undefined;

    await this.sessionBackend.killSession(agent.sessionName);

    if (agent.workspace) {
      try {
        await agent.workspace.provider.cleanup(agent.workspace.prepared);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warning = `Agent session removed, but workspace cleanup failed: ${message}`;
      }
    }

    this.agents.delete(agentId);
    this.emitAgentsChanged();
    return warning;
  }

  async detachAll(): Promise<void> {
    await Promise.all(
      Array.from(this.agents.values()).map(async (agent) => {
        agent.detaching = true;
        try {
          agent.terminal.kill();
        } catch {
          // ignore
        }
      }),
    );
  }

  private async attachDiscoveredSession(
    session: DiscoveredSession,
    createdAt: number,
    workspace: WorkspaceHandle | null,
  ): Promise<AgentRecord> {
    const ptyProcess = this.sessionBackend.attach(session, {
      cols: this.initialCols,
      rows: this.initialRows,
    });

    const agent: AgentRecord = {
      id: session.agentId,
      name: session.name,
      cwd: session.cwd,
      folderTag: folderTagFromCwd(session.cwd),
      sessionName: session.sessionName,
      status: session.running ? 'running' : session.lastExitCode === 0 ? 'exited' : 'error',
      createdAt,
      updatedAt: Date.now(),
      lastExitCode: session.lastExitCode,
      terminal: new TerminalSession(
        ptyProcess,
        {
          onData: (data) => {
            agent.updatedAt = Date.now();
            this.emit('terminalData', agent.id, data);
          },
          onClipboardCopy: (text) => {
            agent.updatedAt = Date.now();
            this.emit('clipboardCopy', agent.id, text);
          },
          onExit: (exitCode) => {
            if (agent.suppressedTerminalExitCount > 0) {
              agent.suppressedTerminalExitCount -= 1;
              return;
            }
            agent.updatedAt = Date.now();
            agent.lastExitCode = exitCode;
            if (!agent.deleting && !agent.detaching) {
              agent.status = exitCode === 0 ? 'exited' : 'error';
            }
            this.emit('terminalExit', agent.id, exitCode);
            if (!agent.detaching) {
              this.emitAgentsChanged();
            }
          },
        },
        { bufferLimit: this.terminalBufferLimit },
      ),
      deleting: false,
      detaching: false,
      suppressedTerminalExitCount: 0,
      workspace,
    };

    this.agents.set(agent.id, agent);
    return agent;
  }

  private async recoverWorkspace(agentId: string, sessionCwd: string): Promise<WorkspaceHandle | null> {
    for (const provider of this.workspaceProviders) {
      const recovered = await provider.recover(agentId, sessionCwd);
      if (recovered) {
        return { provider, prepared: recovered };
      }
    }
    return null;
  }

  private selectWorkspaceProvider(input: CreateAgentInput): WorkspaceProvider {
    const provider = this.workspaceProviders.find((candidate) => candidate.canPrepare(input));
    if (!provider) {
      throw new Error('No workspace provider available for input');
    }
    return provider;
  }

  private requireAgent(agentId: string): AgentRecord {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }
    return agent;
  }

  private toSummary(agent: AgentRecord): AgentSummary {
    return {
      id: agent.id,
      name: agent.name,
      cwd: agent.cwd,
      folderTag: agent.folderTag,
      sessionName: agent.sessionName,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastExitCode: agent.lastExitCode,
    };
  }

  private emitAgentsChanged(): void {
    this.emit('agentsChanged', this.list());
  }
}
