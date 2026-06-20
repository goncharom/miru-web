import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { relative, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { ClientEvent, CreateAgentInput, ServerEvent, ServerStatusPayload } from '../shared/protocol';
import { contentTypeForPath, LocalArtifactStore } from './artifacts';
import { AgentManager } from './agents';
import {
  APP_NAME,
  DEFAULT_CWD,
  HOST,
  INITIAL_COLS,
  INITIAL_ROWS,
  PI_COMMAND,
  PORT,
  TERMINAL_BUFFER_LIMIT,
  USER_SHELL,
} from './config';
import { readJsonBody, readRequestBody, sendBuffer, sendJson, sendText } from './utils';
import { DirectWorkspaceProvider, GitWorktreeProvider } from './workspaces';
import { ZellijBackend } from './zellij';

const publicDir = resolve(__dirname, '../public');
const artifactStore = new LocalArtifactStore();
const agentManager = new AgentManager({
  sessionBackend: new ZellijBackend({ userShell: USER_SHELL }),
  workspaceProviders: [new GitWorktreeProvider(), new DirectWorkspaceProvider()],
  launchCommand: [PI_COMMAND],
  initialCols: INITIAL_COLS,
  initialRows: INITIAL_ROWS,
  terminalBufferLimit: TERMINAL_BUFFER_LIMIT,
});

const serverInfo: Omit<ServerStatusPayload, 'wsConnected'> = {
  appName: APP_NAME,
  host: HOST,
  port: PORT,
  defaultCwd: DEFAULT_CWD,
};

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
      return;
    }
    res.end();
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  sendWs(socket, {
    type: 'hello',
    agents: agentManager.list(),
    server: serverInfo,
  });

  socket.on('message', (raw) => {
    try {
      const event = JSON.parse(String(raw)) as ClientEvent;
      handleClientEvent(event);
    } catch {
      // Ignore malformed client messages.
    }
  });
});

agentManager.on('agentsChanged', (agents) => {
  broadcast({ type: 'agents', agents });
});

agentManager.on('terminalData', (agentId, data) => {
  broadcast({ type: 'terminal_data', agentId, data });
});

agentManager.on('terminalExit', (agentId, exitCode) => {
  broadcast({ type: 'terminal_exit', agentId, exitCode });
});

agentManager.on('clipboardCopy', (agentId, text) => {
  broadcast({ type: 'clipboard_copy', agentId, text });
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  wss.close();
  server.close();
  await agentManager.detachAll();
  process.exit(0);
}

void bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  await agentManager.restoreExisting();
  server.listen(PORT, HOST, () => {
    console.log(`${APP_NAME} listening on http://${HOST}:${PORT}`);
  });
}

function handleClientEvent(event: ClientEvent): void {
  switch (event.type) {
    case 'terminal_input':
      agentManager.write(event.agentId, event.data);
      return;
    case 'terminal_binary':
      agentManager.write(event.agentId, Buffer.from(event.dataBase64, 'base64').toString('latin1'));
      return;
    case 'terminal_resize':
      agentManager.resize(event.agentId, event.cols, event.rows);
      return;
  }
}

async function handleRequest(req: Parameters<typeof createServer>[0], res: Parameters<typeof createServer>[1]): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/api/status' && method === 'GET') {
    sendJson(res, 200, serverInfo);
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'agents') {
    await handleAgentsApi(parts.slice(2), method, req, res);
    return;
  }

  if (parts[0] === 'artifacts' && parts.length >= 3 && method === 'GET') {
    const agentId = parts[1];
    const relPath = parts.slice(2).join('/');
    const cwd = agentManager.getCwd(agentId);
    if (!cwd || !relPath) {
      sendJson(res, 404, { error: 'Artifact not found' });
      return;
    }
    const { content, contentType } = await artifactStore.read(cwd, relPath);
    sendBuffer(res, 200, content, contentType);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  await serveStatic(url.pathname, res);
}

async function handleAgentsApi(
  parts: string[],
  method: string,
  req: Parameters<typeof createServer>[0],
  res: Parameters<typeof createServer>[1],
): Promise<void> {
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { agents: agentManager.list() });
      return;
    }

    if (method === 'POST') {
      try {
        const input = await readJsonBody<CreateAgentInput>(req);
        const agent = await agentManager.create(input);
        sendJson(res, 201, { agent });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const [agentId, section, action] = parts;
  const agent = agentManager.getSummary(agentId);
  const cwd = agentManager.getCwd(agentId);

  if (parts.length === 1) {
    if (method === 'DELETE') {
      if (!agent) {
        sendJson(res, 404, { error: 'Agent not found' });
        return;
      }
      const warning = await agentManager.delete(agentId);
      sendJson(res, 200, warning ? { ok: true, warning } : { ok: true });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (!agent || !cwd) {
    sendJson(res, 404, { error: 'Agent not found' });
    return;
  }

  if (section === 'input' && method === 'POST') {
    try {
      const payload = await readJsonBody<{ data: string }>(req);
      if (typeof payload.data !== 'string') throw new Error('Expected string data');
      agentManager.write(agentId, payload.data);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (section === 'resize' && method === 'POST') {
    try {
      const payload = await readJsonBody<{ cols: number; rows: number }>(req);
      agentManager.resize(agentId, payload.cols, payload.rows);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (section === 'terminal-buffer' && method === 'GET') {
    sendJson(res, 200, { data: agentManager.getBuffer(agentId) });
    return;
  }

  if (section === 'artifacts' && !action && method === 'GET') {
    const artifacts = await artifactStore.list(cwd);
    sendJson(res, 200, { artifacts });
    return;
  }

  if (section === 'artifacts' && action === 'upload-image' && method === 'POST') {
    try {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      const originalName = String(req.headers['x-file-name'] ?? '');
      const body = await readRequestBody(req);
      const result = await artifactStore.saveImage(cwd, body, contentType, originalName);
      sendJson(res, 201, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function serveStatic(pathname: string, res: Parameters<typeof createServer>[1]): Promise<void> {
  const target = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolutePath = resolve(publicDir, target);
  const rel = relative(publicDir, absolutePath);
  if (rel.startsWith('..') || rel === '..') {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(absolutePath);
    sendBuffer(res, 200, content, contentTypeForPath(absolutePath));
  } catch {
    sendText(res, 404, 'Not found');
  }
}

function broadcast(event: ServerEvent): void {
  const encoded = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(encoded);
    }
  }
}

function sendWs(socket: { send: (data: string) => void }, event: ServerEvent): void {
  socket.send(JSON.stringify(event));
}
