import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import * as pty from 'node-pty';
import type { CreateAgentInput, AgentSummary } from '../shared/protocol';
import { INITIAL_COLS, INITIAL_ROWS, TERMINAL_BUFFER_LIMIT } from './config';
import { createZellijSession, killZellijSession } from './zellij';
import { defaultAgentName, folderTagFromCwd, makeAgentId, makeSessionName, validateDirectory } from './utils';

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
  terminal: pty.IPty;
  buffer: string;
  deleting: boolean;
}

export interface AgentsEvents {
  agentsChanged: (agents: AgentSummary[]) => void;
  terminalData: (agentId: string, data: string) => void;
  terminalExit: (agentId: string, exitCode: number | null) => void;
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentRecord>();

  list(): AgentSummary[] {
    return Array.from(this.agents.values())
      .map((agent) => this.toSummary(agent))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  getBuffer(agentId: string): string {
    const agent = this.requireAgent(agentId);
    return agent.buffer;
  }

  async create(input: CreateAgentInput): Promise<AgentSummary> {
    const cwd = resolve(input.cwd.trim());
    await validateDirectory(cwd);

    const id = makeAgentId();
    const name = (input.name?.trim() || defaultAgentName(cwd)).slice(0, 80);
    const sessionName = makeSessionName(id);
    const now = Date.now();

    await createZellijSession(sessionName, cwd, name);

    const terminal = pty.spawn('zellij', ['attach', sessionName], {
      name: 'xterm-256color',
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    const agent: AgentRecord = {
      id,
      name,
      cwd,
      folderTag: folderTagFromCwd(cwd),
      sessionName,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      lastExitCode: null,
      terminal,
      buffer: '',
      deleting: false,
    };

    terminal.onData((data) => {
      agent.updatedAt = Date.now();
      agent.buffer += data;
      if (agent.buffer.length > TERMINAL_BUFFER_LIMIT) {
        agent.buffer = agent.buffer.slice(agent.buffer.length - TERMINAL_BUFFER_LIMIT);
      }
      this.emit('terminalData', agent.id, data);
    });

    terminal.onExit(({ exitCode }) => {
      agent.updatedAt = Date.now();
      agent.lastExitCode = exitCode;
      if (!agent.deleting) {
        agent.status = exitCode === 0 ? 'exited' : 'error';
      }
      this.emit('terminalExit', agent.id, exitCode);
      this.emitAgentsChanged();
    });

    this.agents.set(id, agent);
    this.emitAgentsChanged();
    return this.toSummary(agent);
  }

  write(agentId: string, data: string): void {
    const agent = this.requireAgent(agentId);
    agent.terminal.write(data);
    agent.updatedAt = Date.now();
  }

  resize(agentId: string, cols: number, rows: number): void {
    const agent = this.requireAgent(agentId);
    const safeCols = Math.max(20, Math.floor(cols));
    const safeRows = Math.max(6, Math.floor(rows));
    agent.terminal.resize(safeCols, safeRows);
    agent.updatedAt = Date.now();
  }

  async delete(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.deleting = true;

    try {
      agent.terminal.kill();
    } catch {
      // ignore
    }

    await killZellijSession(agent.sessionName);
    this.agents.delete(agentId);
    this.emitAgentsChanged();
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.agents.keys()).map((agentId) => this.delete(agentId).catch(() => undefined)));
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
