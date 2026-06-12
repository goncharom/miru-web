export type AgentStatus = 'starting' | 'running' | 'exited' | 'error';

export interface AgentSummary {
  id: string;
  name: string;
  cwd: string;
  folderTag: string;
  sessionName: string;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
  lastExitCode: number | null;
}

export type ArtifactKind = 'html' | 'image' | 'file';

export interface ArtifactEntry {
  relPath: string;
  absPath: string;
  kind: ArtifactKind;
  size: number;
  mtimeMs: number;
}

export interface ServerStatusPayload {
  appName: string;
  host: string;
  port: number;
  defaultCwd: string;
  wsConnected: boolean;
}

export interface CreateAgentInput {
  cwd: string;
  name?: string;
}

export interface UploadImageResult {
  relPath: string;
  absPath: string;
}

export interface AgentBufferPayload {
  data: string;
}

export type ServerEvent =
  | {
      type: 'hello';
      agents: AgentSummary[];
      server: Omit<ServerStatusPayload, 'wsConnected'>;
    }
  | {
      type: 'agents';
      agents: AgentSummary[];
    }
  | {
      type: 'terminal_data';
      agentId: string;
      data: string;
    }
  | {
      type: 'terminal_exit';
      agentId: string;
      exitCode: number | null;
    };

export type ClientEvent =
  | {
      type: 'terminal_input';
      agentId: string;
      data: string;
    }
  | {
      type: 'terminal_resize';
      agentId: string;
      cols: number;
      rows: number;
    };
