import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import * as pty from 'node-pty';
import type { CreateAgentInput, AgentSummary } from '../shared/protocol';
import { INITIAL_COLS, INITIAL_ROWS, TERMINAL_BUFFER_LIMIT } from './config';
import { createZellijSession, discoverMiruSessions, type DiscoveredMiruSession, killZellijSession } from './zellij';
import {
  defaultAgentName,
  folderTagFromCwd,
  makeAgentId,
  makeSessionName,
  validateDirectory,
} from './utils';

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
  detaching: boolean;
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

  async restoreExisting(): Promise<void> {
    const discovered = await discoverMiruSessions();
    let index = 0;

    for (const session of discovered) {
      if (this.agents.has(session.agentId)) continue;
      await this.attachDiscoveredSession(session, Date.now() + index);
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

    await createZellijSession(sessionName, cwd, name);

    const agent = await this.attachDiscoveredSession(
      {
        agentId: id,
        sessionName,
        name,
        cwd,
        lastExitCode: null,
        running: true,
      },
      Date.now(),
    );

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

  private async attachDiscoveredSession(session: DiscoveredMiruSession, createdAt: number): Promise<AgentRecord> {
    const terminal = pty.spawn('zellij', ['attach', session.sessionName], {
      name: 'xterm-256color',
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      cwd: session.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
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
      terminal,
      buffer: '',
      deleting: false,
      detaching: false,
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
      if (!agent.deleting && !agent.detaching) {
        agent.status = exitCode === 0 ? 'exited' : 'error';
      }
      this.emit('terminalExit', agent.id, exitCode);
      if (!agent.detaching) {
        this.emitAgentsChanged();
      }
    });

    this.agents.set(agent.id, agent);
    return agent;
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
