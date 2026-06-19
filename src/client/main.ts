import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import './theme.css';
import type {
  AgentBufferPayload,
  AgentSummary,
  ArtifactEntry,
  ClientEvent,
  CreateAgentInput,
  ServerEvent,
  ServerStatusPayload,
  UploadImageResult,
} from '../shared/protocol';

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

interface TerminalState {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  initialized: boolean;
  initializing: boolean;
  queuedChunks: string[];
  lastSentCols: number;
  lastSentRows: number;
  initVersion: number;
}

const shell = getElement<HTMLDivElement>('shell');
const serverStatusEl = getElement<HTMLDivElement>('server-status');
const createAgentForm = getElement<HTMLFormElement>('create-agent-form');
const createAgentErrorEl = getElement<HTMLDivElement>('create-agent-error');
const agentCwdInput = getElement<HTMLInputElement>('agent-cwd');
const agentNameInput = getElement<HTMLInputElement>('agent-name');
const agentWorkspaceInput = getElement<HTMLInputElement>('agent-workspace');
const agentListEl = getElement<HTMLDivElement>('agent-list');
const selectedAgentNameEl = getElement<HTMLDivElement>('selected-agent-name');
const selectedAgentDetailEl = getElement<HTMLDivElement>('selected-agent-detail');
const selectedAgentStatusEl = getElement<HTMLDivElement>('selected-agent-status');
const terminalStackEl = getElement<HTMLDivElement>('terminal-stack');
const terminalEmptyEl = getElement<HTMLDivElement>('terminal-empty');
const artifactListEl = getElement<HTMLDivElement>('artifact-list');
const chooseImageButton = getElement<HTMLButtonElement>('choose-image');
const imageInput = getElement<HTMLInputElement>('image-input');
const pasteTarget = getElement<HTMLDivElement>('paste-target');
const uploadStatusEl = getElement<HTMLDivElement>('upload-status');
const uploadedPathRow = getElement<HTMLDivElement>('uploaded-path-row');
const uploadedPathText = getElement<HTMLDivElement>('uploaded-path-text');
const copyUploadedPathButton = getElement<HTMLButtonElement>('copy-uploaded-path');
const insertUploadedPathButton = getElement<HTMLButtonElement>('insert-uploaded-path');
const leftSplitter = getElement<HTMLDivElement>('left-splitter');
const rightSplitter = getElement<HTMLDivElement>('right-splitter');
const toggleLeftButton = getElement<HTMLButtonElement>('toggle-left');
const toggleRightButton = getElement<HTMLButtonElement>('toggle-right');

const layoutStorageKey = 'miru-web-layout';
const selectedAgentStorageKey = 'miru-web-selected-agent';

const state: {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  activityAgentIds: Set<string>;
  terminals: Map<string, TerminalState>;
  artifacts: ArtifactEntry[];
  layout: LayoutState;
  server: Omit<ServerStatusPayload, 'wsConnected'> | null;
  ws: WebSocket | null;
  wsConnected: boolean;
  uploadedPath: string;
  artifactRequestToken: number;
  resizeObserver: ResizeObserver | null;
  agentsRenderQueued: boolean;
} = {
  agents: [],
  selectedAgentId: window.localStorage.getItem(selectedAgentStorageKey),
  activityAgentIds: new Set<string>(),
  terminals: new Map<string, TerminalState>(),
  artifacts: [],
  layout: loadLayout(),
  server: null,
  ws: null,
  wsConnected: false,
  uploadedPath: '',
  artifactRequestToken: 0,
  resizeObserver: null,
  agentsRenderQueued: false,
};

applyLayout();
attachUiEvents();
connectWebSocket();
window.setInterval(() => {
  if (state.selectedAgentId) {
    runTask(loadArtifacts({ quiet: true }));
  }
}, 2500);

function attachUiEvents(): void {
  createAgentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runTask(createAgent());
  });

  chooseImageButton.addEventListener('click', () => {
    imageInput.click();
  });

  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (file) runTask(uploadImage(file));
  });

  pasteTarget.addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      setUploadStatus('Clipboard does not contain an image.', true);
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      setUploadStatus('Could not read image from clipboard.', true);
      return;
    }
    event.preventDefault();
    runTask(uploadImage(file));
  });

  copyUploadedPathButton.addEventListener('click', async () => {
    if (!state.uploadedPath) return;
    const copied = await copyText(state.uploadedPath);
    setUploadStatus(copied ? 'Copied full path.' : 'Could not copy path.', !copied);
  });

  insertUploadedPathButton.addEventListener('click', () => {
    if (!state.uploadedPath) return;
    insertPathIntoTerminal(state.uploadedPath);
  });

  toggleLeftButton.addEventListener('click', () => {
    state.layout.leftCollapsed = !state.layout.leftCollapsed;
    applyLayout();
    persistLayout();
    scheduleFitSelectedTerminal();
  });

  toggleRightButton.addEventListener('click', () => {
    state.layout.rightCollapsed = !state.layout.rightCollapsed;
    applyLayout();
    persistLayout();
    scheduleFitSelectedTerminal();
  });

  attachSplitterDrag(leftSplitter, 'left');
  attachSplitterDrag(rightSplitter, 'right');
  window.addEventListener('resize', () => scheduleFitSelectedTerminal());

  if (typeof ResizeObserver !== 'undefined') {
    state.resizeObserver = new ResizeObserver(() => {
      scheduleFitSelectedTerminal();
    });
    state.resizeObserver.observe(terminalStackEl);
  }
}

function connectWebSocket(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.ws = socket;

  socket.addEventListener('open', () => {
    state.wsConnected = true;
    renderServerStatus();
  });

  socket.addEventListener('close', () => {
    state.wsConnected = false;
    renderServerStatus();
    window.setTimeout(() => connectWebSocket(), 1000);
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data)) as ServerEvent;
    handleServerEvent(payload);
  });
}

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'hello':
      state.server = event.server;
      if (!agentCwdInput.value) {
        agentCwdInput.value = suggestedCwd();
      }
      replaceAgents(event.agents);
      renderServerStatus();
      if (state.selectedAgentId) {
        const terminalState = state.terminals.get(state.selectedAgentId);
        if (terminalState) {
          terminalState.initialized = false;
          terminalState.initializing = false;
          terminalState.queuedChunks = [];
          terminalState.initVersion += 1;
        }
        runTask(ensureTerminalReady(state.selectedAgentId));
        runTask(loadArtifacts({ quiet: true }));
      }
      return;
    case 'agents':
      replaceAgents(event.agents);
      return;
    case 'terminal_data': {
      if (event.agentId !== state.selectedAgentId) {
        markAgentActivity(event.agentId);
      }
      const terminalState = state.terminals.get(event.agentId);
      if (terminalState?.initialized) {
        terminalState.terminal.write(event.data);
      } else if (terminalState?.initializing) {
        terminalState.queuedChunks.push(event.data);
      }
      return;
    }
    case 'terminal_exit':
      if (event.agentId !== state.selectedAgentId) {
        markAgentActivity(event.agentId);
      }
      return;
    case 'clipboard_copy':
      if (event.agentId === state.selectedAgentId) {
        runTask(copyTerminalClipboard(event.text));
      }
      return;
  }
}

function replaceAgents(agents: AgentSummary[]): void {
  state.agents = agents;

  for (const existingId of Array.from(state.terminals.keys())) {
    if (!state.agents.some((agent) => agent.id === existingId)) {
      const terminalState = state.terminals.get(existingId);
      terminalState?.terminal.dispose();
      terminalState?.container.remove();
      state.terminals.delete(existingId);
      state.activityAgentIds.delete(existingId);
    }
  }

  if (state.selectedAgentId && !state.agents.some((agent) => agent.id === state.selectedAgentId)) {
    state.selectedAgentId = null;
  }

  if (!state.selectedAgentId && state.agents.length > 0) {
    state.selectedAgentId = state.agents[0].id;
  }

  persistSelectedAgent();
  renderAgents();
  renderSelectedAgentHeader();
  renderTerminalSelection();
  runTask(ensureTerminalReady(state.selectedAgentId));
  runTask(loadArtifacts({ quiet: true }));
}

async function createAgent(): Promise<void> {
  const cwd = agentCwdInput.value.trim();
  const name = agentNameInput.value.trim();
  const workspaceName = agentWorkspaceInput.value.trim();
  createAgentErrorEl.textContent = '';

  if (!cwd) {
    createAgentErrorEl.textContent = 'Folder path is required.';
    return;
  }

  const payload: CreateAgentInput = {
    cwd,
    name: name || undefined,
    workspaceName: workspaceName || undefined,
  };

  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.agent) {
    createAgentErrorEl.textContent = body?.error ?? 'Could not create agent.';
    return;
  }

  createAgentErrorEl.textContent = '';
  agentNameInput.value = '';
  agentWorkspaceInput.value = '';
  state.selectedAgentId = body.agent.id;
  persistSelectedAgent();
  state.activityAgentIds.delete(body.agent.id);
  renderAgents();
  renderSelectedAgentHeader();
  renderTerminalSelection();
  await ensureTerminalReady(body.agent.id);
  await loadArtifacts({ quiet: true });
}

function renderAgents(): void {
  agentListEl.innerHTML = '';

  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No agents yet.';
    agentListEl.append(empty);
    return;
  }

  for (const agent of state.agents) {
    const row = document.createElement('div');
    row.className = `agent-row${agent.id === state.selectedAgentId ? ' selected' : ''}`;
    row.addEventListener('click', () => {
      runTask(selectAgent(agent.id));
    });

    const statusDot = document.createElement('div');
    statusDot.className = `status-dot status-${agent.status}`;
    statusDot.title = agent.status;

    const activityDot = document.createElement('div');
    activityDot.className = `activity-dot${state.activityAgentIds.has(agent.id) ? ' active' : ''}`;
    activityDot.title = state.activityAgentIds.has(agent.id) ? 'New output' : 'No new output';

    const main = document.createElement('div');
    main.className = 'agent-row-main';

    const nameLine = document.createElement('div');
    nameLine.className = 'agent-name-line';

    const nameEl = document.createElement('div');
    nameEl.className = 'agent-name';
    nameEl.textContent = agent.name;

    const tagEl = document.createElement('div');
    tagEl.className = 'folder-tag';
    tagEl.textContent = agent.folderTag;
    tagEl.title = agent.cwd;

    nameLine.append(statusDot, activityDot, nameEl, tagEl);

    const subline = document.createElement('div');
    subline.className = 'agent-subline';
    subline.textContent = `${agent.sessionName} · ${agent.cwd}`;
    subline.title = agent.cwd;

    main.append(nameLine, subline);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'agent-delete';
    deleteButton.textContent = '×';
    deleteButton.title = 'Delete agent';
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      runTask(deleteAgent(agent.id));
    });

    row.append(main, deleteButton);
    agentListEl.append(row);
  }
}

async function selectAgent(agentId: string | null): Promise<void> {
  state.selectedAgentId = agentId;
  hideUploadedPath();
  if (agentId) {
    state.activityAgentIds.delete(agentId);
  }
  persistSelectedAgent();
  renderAgents();
  renderSelectedAgentHeader();
  renderTerminalSelection();
  await ensureTerminalReady(agentId);
  await loadArtifacts({ quiet: true });
}

function renderSelectedAgentHeader(): void {
  const agent = selectedAgent();
  if (!agent) {
    selectedAgentNameEl.textContent = 'No agent selected';
    selectedAgentDetailEl.textContent = 'Create an agent to begin.';
    selectedAgentStatusEl.textContent = '—';
    return;
  }

  selectedAgentNameEl.textContent = agent.name;
  selectedAgentDetailEl.textContent = `${agent.cwd} · ${agent.sessionName}`;
  selectedAgentStatusEl.textContent = agent.status;
}

function renderTerminalSelection(): void {
  const selectedId = state.selectedAgentId;
  terminalEmptyEl.style.display = selectedId ? 'none' : 'block';

  for (const [agentId, terminalState] of state.terminals) {
    terminalState.container.classList.toggle('active', agentId === selectedId);
  }

  if (selectedId) {
    scheduleFitSelectedTerminal();
  }
}

async function ensureTerminalReady(agentId: string | null): Promise<void> {
  if (!agentId) return;

  const terminalState = ensureTerminalState(agentId);
  if (terminalState.initialized || terminalState.initializing) {
    if (terminalState.initialized && state.selectedAgentId === agentId) {
      focusTerminal(agentId);
    }
    return;
  }

  terminalState.initializing = true;
  terminalState.queuedChunks = [];
  const initVersion = ++terminalState.initVersion;

  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/terminal-buffer`);
    const body = (await response.json()) as AgentBufferPayload;
    if (terminalState.initVersion !== initVersion) {
      return;
    }
    terminalState.terminal.reset();
    terminalState.terminal.write(body.data || '');
    for (const chunk of terminalState.queuedChunks) {
      terminalState.terminal.write(chunk);
    }
    terminalState.initialized = true;
    terminalState.queuedChunks = [];
    if (state.selectedAgentId === agentId) {
      focusTerminal(agentId);
    }
  } finally {
    if (terminalState.initVersion === initVersion) {
      terminalState.initializing = false;
    }
  }
}

function ensureTerminalState(agentId: string): TerminalState {
  const existing = state.terminals.get(agentId);
  if (existing) return existing;

  const container = document.createElement('div');
  container.className = 'terminal-instance';
  terminalStackEl.append(container);

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selectionBackground: 'rgba(255, 255, 255, 0.25)',
    },
    scrollback: 10000,
    allowTransparency: false,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  attachTerminalKeyHandler(terminal, agentId);
  attachTerminalPasteHandler(container, terminal, agentId);
  terminal.onData((data) => {
    sendClientEvent({ type: 'terminal_input', agentId, data });
  });
  terminal.onBinary((data) => {
    sendClientEvent({ type: 'terminal_binary', agentId, dataBase64: window.btoa(data) });
  });

  const terminalState: TerminalState = {
    terminal,
    fitAddon,
    container,
    initialized: false,
    initializing: false,
    queuedChunks: [],
    lastSentCols: 0,
    lastSentRows: 0,
    initVersion: 0,
  };

  state.terminals.set(agentId, terminalState);
  return terminalState;
}

function attachTerminalKeyHandler(terminal: Terminal, agentId: string): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return true;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.type === 'keydown') {
      sendClientEvent({
        type: 'terminal_input',
        agentId,
        data: '\u001b[13;2u',
      });
    }

    return false;
  });
}

function attachTerminalPasteHandler(container: HTMLDivElement, terminal: Terminal, agentId: string): void {
  container.addEventListener(
    'paste',
    (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text || !/[\r\n]/.test(text)) return;

      event.preventDefault();
      event.stopPropagation();
      sendBracketedTerminalPaste(agentId, text);
      terminal.focus();
    },
    { capture: true },
  );
}

function sendBracketedTerminalPaste(agentId: string, text: string): void {
  const normalized = text.replace(/\r?\n/g, '\r');
  sendClientEvent({
    type: 'terminal_input',
    agentId,
    data: `\u001b[200~${normalized}\u001b[201~`,
  });
}

function focusTerminal(agentId: string): void {
  const terminalState = state.terminals.get(agentId);
  if (!terminalState) return;
  renderTerminalSelection();
  scheduleFitSelectedTerminal();
  terminalState.terminal.focus();
}

function fitSelectedTerminal(): void {
  const agentId = state.selectedAgentId;
  if (!agentId) return;
  const terminalState = state.terminals.get(agentId);
  if (!terminalState) return;
  if (!terminalState.container.classList.contains('active')) return;

  const rect = terminalState.container.getBoundingClientRect();
  if (rect.width < 32 || rect.height < 32) return;

  terminalState.fitAddon.fit();

  if (
    terminalState.terminal.cols === terminalState.lastSentCols &&
    terminalState.terminal.rows === terminalState.lastSentRows
  ) {
    return;
  }

  terminalState.lastSentCols = terminalState.terminal.cols;
  terminalState.lastSentRows = terminalState.terminal.rows;

  sendClientEvent({
    type: 'terminal_resize',
    agentId,
    cols: terminalState.terminal.cols,
    rows: terminalState.terminal.rows,
  });
}

function scheduleFitSelectedTerminal(): void {
  requestAnimationFrame(() => {
    fitSelectedTerminal();
    window.setTimeout(() => fitSelectedTerminal(), 60);
    window.setTimeout(() => fitSelectedTerminal(), 180);
  });
}

async function deleteAgent(agentId: string): Promise<void> {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  if (!window.confirm(`Delete agent ${agent.name}? This kills its zellij session.`)) return;

  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    window.alert(body?.error ?? 'Could not delete agent.');
    return;
  }

  if (body?.warning) {
    window.alert(body.warning);
  }

  if (state.selectedAgentId === agentId) {
    state.selectedAgentId = null;
    persistSelectedAgent();
  }
}

async function loadArtifacts(options: { quiet: boolean }): Promise<void> {
  const agent = selectedAgent();
  if (!agent) {
    state.artifacts = [];
    renderArtifacts();
    setUploadStatus('Select an agent to upload.', false);
    return;
  }

  const requestToken = ++state.artifactRequestToken;
  const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/artifacts`);
  if (!response.ok) {
    if (!options.quiet) {
      setUploadStatus('Could not load artifacts.', true);
    }
    return;
  }

  const body = await response.json().catch(() => null);
  if (requestToken !== state.artifactRequestToken) return;
  state.artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  renderArtifacts();
  if (!state.uploadedPath) {
    setUploadStatus('Ready for image upload.', false);
  }
}

function renderArtifacts(): void {
  artifactListEl.innerHTML = '';
  const agent = selectedAgent();
  if (!agent) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select an agent to browse .miru artifacts.';
    artifactListEl.append(empty);
    return;
  }

  const entries = state.artifacts;
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No artifacts yet.';
    artifactListEl.append(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'artifact-row';

    const main = document.createElement('div');
    main.className = 'artifact-row-main';

    const nameLine = document.createElement('div');
    nameLine.className = 'artifact-name';

    const kind = document.createElement('span');
    kind.className = 'kind-pill';
    kind.textContent = entry.kind;

    const path = document.createElement('span');
    path.className = 'artifact-path';
    path.textContent = entry.relPath;
    path.title = entry.absPath;

    nameLine.append(kind, path);

    const meta = document.createElement('div');
    meta.className = 'artifact-meta';
    meta.textContent = new Date(entry.mtimeMs).toLocaleString();

    main.append(nameLine, meta);

    const actions = document.createElement('div');
    actions.className = 'artifact-actions';

    if (entry.kind === 'html') {
      const openLink = document.createElement('a');
      openLink.href = `/artifacts/${encodeURIComponent(agent.id)}/${encodeArtifactPath(entry.relPath)}`;
      openLink.target = '_blank';
      openLink.rel = 'noreferrer';
      openLink.textContent = 'Open';
      actions.append(openLink);
    }

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Copy path';
    copyButton.addEventListener('click', async () => {
      const copied = await copyText(entry.absPath);
      setUploadStatus(copied ? 'Copied full path.' : 'Could not copy path.', !copied);
    });

    const insertButton = document.createElement('button');
    insertButton.type = 'button';
    insertButton.textContent = 'Insert path';
    insertButton.addEventListener('click', () => {
      insertPathIntoTerminal(entry.absPath);
    });

    actions.append(copyButton, insertButton);
    row.append(main, actions);
    artifactListEl.append(row);
  }
}

async function uploadImage(file: File): Promise<void> {
  const agent = selectedAgent();
  if (!agent) {
    setUploadStatus('Select an agent before uploading.', true);
    return;
  }

  setUploadStatus('Uploading image…', false);
  hideUploadedPath();

  const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/artifacts/upload-image`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-File-Name': file.name,
    },
    body: await file.arrayBuffer(),
  });

  const body = (await response.json().catch(() => null)) as UploadImageResult | { error?: string } | null;
  if (!response.ok || !body || typeof (body as UploadImageResult).absPath !== 'string') {
    setUploadStatus((body as { error?: string } | null)?.error ?? 'Upload failed.', true);
    return;
  }

  const result = body as UploadImageResult;
  state.uploadedPath = result.absPath;
  uploadedPathText.textContent = result.absPath;
  uploadedPathRow.hidden = false;
  setUploadStatus('Saved image.', false);
  await loadArtifacts({ quiet: true });
}

function hideUploadedPath(): void {
  state.uploadedPath = '';
  uploadedPathText.textContent = '';
  uploadedPathRow.hidden = true;
}

function setUploadStatus(message: string, isError: boolean): void {
  uploadStatusEl.textContent = message;
  uploadStatusEl.style.color = isError ? 'var(--danger)' : '';
}

function insertPathIntoTerminal(path: string): void {
  const agentId = state.selectedAgentId;
  if (!agentId) return;
  sendClientEvent({ type: 'terminal_input', agentId, data: path });
  setUploadStatus('Inserted path into terminal input.', false);
  const terminalState = state.terminals.get(agentId);
  terminalState?.terminal.focus();
}

function sendClientEvent(event: ClientEvent): void {
  const socket = state.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(event));
}

function markAgentActivity(agentId: string): void {
  if (state.activityAgentIds.has(agentId)) return;
  state.activityAgentIds.add(agentId);
  scheduleRenderAgents();
}

function scheduleRenderAgents(): void {
  if (state.agentsRenderQueued) return;
  state.agentsRenderQueued = true;
  requestAnimationFrame(() => {
    state.agentsRenderQueued = false;
    renderAgents();
  });
}

function renderServerStatus(): void {
  if (!state.server) {
    serverStatusEl.textContent = 'Connecting…';
    return;
  }

  serverStatusEl.textContent = `${state.server.host}:${state.server.port} · ${state.wsConnected ? 'connected' : 'reconnecting…'}`;
}

function selectedAgent(): AgentSummary | undefined {
  return state.selectedAgentId ? state.agents.find((agent) => agent.id === state.selectedAgentId) : undefined;
}

function suggestedCwd(): string {
  return selectedAgent()?.cwd ?? state.server?.defaultCwd ?? '';
}

function persistSelectedAgent(): void {
  if (state.selectedAgentId) {
    window.localStorage.setItem(selectedAgentStorageKey, state.selectedAgentId);
  } else {
    window.localStorage.removeItem(selectedAgentStorageKey);
  }
}

function loadLayout(): LayoutState {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey);
    if (!raw) {
      return { leftWidth: 280, rightWidth: 360, leftCollapsed: false, rightCollapsed: false };
    }
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      leftWidth: clamp(parsed.leftWidth ?? 280, 180, 520),
      rightWidth: clamp(parsed.rightWidth ?? 360, 240, 620),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    };
  } catch {
    return { leftWidth: 280, rightWidth: 360, leftCollapsed: false, rightCollapsed: false };
  }
}

function persistLayout(): void {
  window.localStorage.setItem(layoutStorageKey, JSON.stringify(state.layout));
}

function applyLayout(): void {
  shell.style.setProperty('--left-pane-width', `${state.layout.leftWidth}px`);
  shell.style.setProperty('--right-pane-width', `${state.layout.rightWidth}px`);
  shell.classList.toggle('left-collapsed', state.layout.leftCollapsed);
  shell.classList.toggle('right-collapsed', state.layout.rightCollapsed);
  toggleLeftButton.textContent = state.layout.leftCollapsed ? '▸' : '◂';
  toggleRightButton.textContent = state.layout.rightCollapsed ? '◂' : '▸';
}

function attachSplitterDrag(splitter: HTMLDivElement, side: 'left' | 'right'): void {
  splitter.addEventListener('mousedown', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    if ((side === 'left' && state.layout.leftCollapsed) || (side === 'right' && state.layout.rightCollapsed)) {
      return;
    }

    event.preventDefault();
    splitter.classList.add('dragging');
    const shellRect = shell.getBoundingClientRect();

    const onMove = (moveEvent: MouseEvent) => {
      if (side === 'left') {
        const maxWidth = shellRect.width - (state.layout.rightCollapsed ? 0 : state.layout.rightWidth) - 280;
        state.layout.leftWidth = clamp(moveEvent.clientX - shellRect.left, 180, Math.max(240, maxWidth));
      } else {
        const maxWidth = shellRect.width - (state.layout.leftCollapsed ? 0 : state.layout.leftWidth) - 280;
        state.layout.rightWidth = clamp(shellRect.right - moveEvent.clientX, 240, Math.max(280, maxWidth));
      }
      applyLayout();
      scheduleFitSelectedTerminal();
    };

    const onUp = () => {
      splitter.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persistLayout();
      scheduleFitSelectedTerminal();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function encodeArtifactPath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyTerminalClipboard(text: string): Promise<void> {
  const copied = await copyText(text);
  if (!copied) {
    console.warn('Could not copy terminal selection to clipboard.');
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function runTask(task: Promise<unknown>): void {
  task.catch((error) => {
    console.error(error);
  });
}
