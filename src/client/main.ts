import './theme.css';
import type {
  AgentSummary,
  ArtifactEntry,
  ClientEvent,
  CreateAgentInput,
  ServerEvent,
  ServerStatusPayload,
  UploadImageResult,
} from '../shared/protocol';
import { ExtensionRegistry, registerBuiltInExtensions, type ClientContext } from './extensions';
import { TerminalController } from './terminal';

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
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
const rightPaneTabsEl = getElement<HTMLDivElement>('right-pane-tabs');
const rightPaneContentEl = getElement<HTMLDivElement>('right-pane-content');
const leftSplitter = getElement<HTMLDivElement>('left-splitter');
const rightSplitter = getElement<HTMLDivElement>('right-splitter');
const toggleLeftButton = getElement<HTMLButtonElement>('toggle-left');
const toggleRightButton = getElement<HTMLButtonElement>('toggle-right');

const layoutStorageKey = 'miru-web-layout';
const selectedAgentStorageKey = 'miru-web-selected-agent';
const rightPanelStorageKey = 'miru-web-right-panel';

const state: {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  activityAgentIds: Set<string>;
  artifacts: ArtifactEntry[];
  layout: LayoutState;
  server: Omit<ServerStatusPayload, 'wsConnected'> | null;
  ws: WebSocket | null;
  wsConnected: boolean;
  uploadedPath: string;
  uploadStatusMessage: string;
  uploadStatusError: boolean;
  artifactRequestToken: number;
  activeRightPanelId: string | null;
  agentsRenderQueued: boolean;
  activePanelCleanup: (() => void) | null;
} = {
  agents: [],
  selectedAgentId: window.localStorage.getItem(selectedAgentStorageKey),
  activityAgentIds: new Set<string>(),
  artifacts: [],
  layout: loadLayout(),
  server: null,
  ws: null,
  wsConnected: false,
  uploadedPath: '',
  uploadStatusMessage: 'Select an agent to upload.',
  uploadStatusError: false,
  artifactRequestToken: 0,
  activeRightPanelId: window.localStorage.getItem(rightPanelStorageKey),
  agentsRenderQueued: false,
  activePanelCleanup: null,
};

const registry = new ExtensionRegistry();
const terminals = new TerminalController(terminalStackEl, {
  send: sendClientEvent,
  loadBuffer: async (agentId) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/terminal-buffer`);
    const body = (await response.json().catch(() => null)) as { data?: string } | null;
    return body?.data ?? '';
  },
});

const ctx: ClientContext = {
  getState: () => ({
    agents: [...state.agents],
    selectedAgentId: state.selectedAgentId,
    artifacts: [...state.artifacts],
    wsConnected: state.wsConnected,
  }),
  getSelectedAgent: () => selectedAgent(),
  terminals: {
    insertText: (text) => {
      const agentId = state.selectedAgentId;
      if (!agentId) return;
      terminals.insertText(agentId, text);
    },
  },
  selectAgent,
  copyText,
  setStatus: (message, isError = false) => setUploadStatus(message, isError),
};

registerBuiltInExtensions(registry, ctx, {
  getArtifacts: () => state.artifacts,
  getUploadedPath: () => state.uploadedPath,
  getUploadStatus: () => ({
    message: state.uploadStatusMessage,
    isError: state.uploadStatusError,
  }),
  uploadImage,
});
applyLayout();
attachUiEvents();
connectWebSocket();
render();
window.setInterval(() => {
  if (state.selectedAgentId) {
    runTask(loadArtifacts({ quiet: true }));
  }
}, 2500);
window.addEventListener('beforeunload', () => terminals.dispose());

function attachUiEvents(): void {
  createAgentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runTask(submitCreateAgentForm());
  });

  toggleLeftButton.addEventListener('click', () => {
    state.layout.leftCollapsed = !state.layout.leftCollapsed;
    applyLayout();
    persistLayout();
    terminals.fitSelected();
  });

  toggleRightButton.addEventListener('click', () => {
    state.layout.rightCollapsed = !state.layout.rightCollapsed;
    applyLayout();
    persistLayout();
    terminals.fitSelected();
  });

  attachSplitterDrag(leftSplitter, 'left');
  attachSplitterDrag(rightSplitter, 'right');
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
      terminals.invalidateAll();
      replaceAgents(event.agents);
      renderServerStatus();
      return;
    case 'agents':
      replaceAgents(event.agents);
      return;
    case 'terminal_data':
      if (event.agentId !== state.selectedAgentId) {
        markAgentActivity(event.agentId);
      }
      terminals.handleOutput(event.agentId, event.data);
      return;
    case 'terminal_exit':
      if (event.agentId !== state.selectedAgentId) {
        markAgentActivity(event.agentId);
      }
      return;
    case 'clipboard_copy':
      runTask(terminals.handleClipboardCopy(event.agentId, event.text));
      return;
  }
}

function replaceAgents(agents: AgentSummary[]): void {
  const previousSelectedId = state.selectedAgentId;
  state.agents = [...agents].sort((a, b) => a.createdAt - b.createdAt);
  terminals.prune(state.agents.map((agent) => agent.id));

  for (const agentId of Array.from(state.activityAgentIds)) {
    if (!state.agents.some((agent) => agent.id === agentId)) {
      state.activityAgentIds.delete(agentId);
    }
  }

  if (state.selectedAgentId && !state.agents.some((agent) => agent.id === state.selectedAgentId)) {
    state.selectedAgentId = null;
  }

  if (!state.selectedAgentId && state.agents.length > 0) {
    state.selectedAgentId = state.agents[0].id;
  }

  if (previousSelectedId !== state.selectedAgentId) {
    hideUploadedPath();
    if (state.selectedAgentId) {
      state.activityAgentIds.delete(state.selectedAgentId);
    }
  }

  persistSelectedAgent();
  renderAgents();
  renderSelectedAgentHeader();
  renderTerminalSelection();
  renderRightPane();
  terminals.select(state.selectedAgentId);

  if (state.selectedAgentId) {
    runTask(
      terminals.ensure(state.selectedAgentId).then(() => {
        terminals.select(state.selectedAgentId);
      }),
    );
  }

  runTask(loadArtifacts({ quiet: true }));
}

async function submitCreateAgentForm(): Promise<void> {
  const cwd = agentCwdInput.value.trim();
  const name = agentNameInput.value.trim();
  const workspaceName = agentWorkspaceInput.value.trim();
  createAgentErrorEl.textContent = '';

  if (!cwd) {
    createAgentErrorEl.textContent = 'Folder path is required.';
    return;
  }

  try {
    await createAgentWithInput({
      cwd,
      name: name || undefined,
      workspaceName: workspaceName || undefined,
    });
    createAgentErrorEl.textContent = '';
    agentNameInput.value = '';
    agentWorkspaceInput.value = '';
  } catch (error) {
    createAgentErrorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function createAgentWithInput(input: CreateAgentInput): Promise<void> {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const body = (await response.json().catch(() => null)) as { agent?: AgentSummary; error?: string } | null;
  if (!response.ok || !body?.agent) {
    throw new Error(body?.error ?? 'Could not create agent.');
  }

  state.selectedAgentId = body.agent.id;
  persistSelectedAgent();
  state.activityAgentIds.delete(body.agent.id);
  replaceAgents([...state.agents.filter((agent) => agent.id !== body.agent!.id), body.agent]);
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

  const decorators = registry.getAgentDecorators();

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

    const decoratorsEl = document.createElement('div');
    decoratorsEl.className = 'agent-decorators';
    for (const decorator of decorators) {
      const decoration = decorator.render(agent, ctx);
      if (decoration) {
        decoratorsEl.append(decoration);
      }
    }

    nameLine.append(statusDot, activityDot, nameEl, tagEl);
    if (decoratorsEl.childElementCount > 0) {
      nameLine.append(decoratorsEl);
    }

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
  renderRightPane();
  terminals.select(agentId);
  if (agentId) {
    await terminals.ensure(agentId);
    terminals.select(agentId);
  }
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
  terminalEmptyEl.style.display = state.selectedAgentId ? 'none' : 'block';
}

async function deleteAgent(agentId: string): Promise<void> {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  if (!window.confirm(`Delete agent ${agent.name}? This kills its zellij session.`)) return;

  try {
    const warning = await deleteAgentRequest(agentId);
    if (warning) {
      window.alert(warning);
    }
    if (state.selectedAgentId === agentId) {
      state.selectedAgentId = null;
      persistSelectedAgent();
    }
    replaceAgents(state.agents.filter((item) => item.id !== agentId));
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

async function deleteAgentRequest(agentId: string): Promise<string | undefined> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; warning?: string; error?: string } | null;

  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not delete agent.');
  }

  return body?.warning;
}

async function listArtifactsForAgent(agentId: string): Promise<ArtifactEntry[]> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/artifacts`);
  const body = (await response.json().catch(() => null)) as { artifacts?: ArtifactEntry[]; error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not load artifacts.');
  }
  return Array.isArray(body?.artifacts) ? body.artifacts : [];
}

async function loadArtifacts(options: { quiet: boolean }): Promise<void> {
  const agent = selectedAgent();
  if (!agent) {
    state.artifacts = [];
    updateUploadStatus('Select an agent to upload.', false);
    renderRightPane();
    return;
  }

  const requestToken = ++state.artifactRequestToken;

  try {
    const artifacts = await listArtifactsForAgent(agent.id);
    if (requestToken !== state.artifactRequestToken) return;
    state.artifacts = artifacts;
    if (!state.uploadedPath) {
      updateUploadStatus('Ready for image upload.', false);
    }
  } catch {
    if (!options.quiet) {
      updateUploadStatus('Could not load artifacts.', true);
    }
  }

  renderRightPane();
}

function renderRightPane(): void {
  const panels = registry.getPanels('right-tab');

  rightPaneTabsEl.innerHTML = '';
  if (panels.length === 0) {
    cleanupActivePanel();
    rightPaneContentEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No panels available.';
    rightPaneContentEl.append(empty);
    return;
  }

  if (!state.activeRightPanelId || !panels.some((panel) => panel.id === state.activeRightPanelId)) {
    state.activeRightPanelId = panels[0].id;
    persistActiveRightPanel();
  }

  for (const panel of panels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pane-tab${panel.id === state.activeRightPanelId ? ' selected' : ''}`;
    button.textContent = panel.title;
    button.addEventListener('click', () => {
      state.activeRightPanelId = panel.id;
      persistActiveRightPanel();
      renderRightPane();
    });
    rightPaneTabsEl.append(button);
  }

  const activePanel = panels.find((panel) => panel.id === state.activeRightPanelId);
  cleanupActivePanel();
  rightPaneContentEl.innerHTML = '';

  if (!activePanel) {
    return;
  }

  const cleanup = activePanel.render(rightPaneContentEl, ctx);
  state.activePanelCleanup = typeof cleanup === 'function' ? cleanup : null;
}

async function uploadImage(file: File): Promise<void> {
  const agent = selectedAgent();
  if (!agent) {
    setUploadStatus('Select an agent before uploading.', true);
    return;
  }

  updateUploadStatus('Uploading image…', false);
  hideUploadedPath();
  renderRightPane();

  try {
    const result = await uploadImageForAgent(agent.id, file);
    state.uploadedPath = result.absPath;
    updateUploadStatus('Saved image.', false);
    await loadArtifacts({ quiet: true });
  } catch (error) {
    updateUploadStatus(error instanceof Error ? error.message : 'Upload failed.', true);
    renderRightPane();
  }
}

async function uploadImageForAgent(agentId: string, file: File): Promise<UploadImageResult> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/artifacts/upload-image`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-File-Name': file.name,
    },
    body: await file.arrayBuffer(),
  });

  const body = (await response.json().catch(() => null)) as UploadImageResult | { error?: string } | null;
  if (!response.ok || !body || typeof (body as UploadImageResult).absPath !== 'string') {
    throw new Error((body as { error?: string } | null)?.error ?? 'Upload failed.');
  }

  return body as UploadImageResult;
}

function hideUploadedPath(): void {
  state.uploadedPath = '';
}

function updateUploadStatus(message: string, isError: boolean): void {
  state.uploadStatusMessage = message;
  state.uploadStatusError = isError;
}

function setUploadStatus(message: string, isError = false): void {
  updateUploadStatus(message, isError);
  if (state.activeRightPanelId === 'artifacts') {
    renderRightPane();
  }
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

function render(): void {
  renderServerStatus();
  renderAgents();
  renderSelectedAgentHeader();
  renderTerminalSelection();
  renderRightPane();
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

function persistActiveRightPanel(): void {
  if (state.activeRightPanelId) {
    window.localStorage.setItem(rightPanelStorageKey, state.activeRightPanelId);
  } else {
    window.localStorage.removeItem(rightPanelStorageKey);
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
      terminals.fitSelected();
    };

    const onUp = () => {
      splitter.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persistLayout();
      terminals.fitSelected();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function cleanupActivePanel(): void {
  const cleanup = state.activePanelCleanup;
  state.activePanelCleanup = null;
  if (cleanup) {
    cleanup();
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
