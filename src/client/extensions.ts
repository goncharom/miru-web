import type { AgentSummary, ArtifactEntry } from '../shared/protocol';

export interface ClientStateSnapshot {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  artifacts: ArtifactEntry[];
  wsConnected: boolean;
}

export interface ClientContext {
  getState(): Readonly<ClientStateSnapshot>;
  getSelectedAgent(): AgentSummary | undefined;
  terminals: {
    insertText(text: string): void;
  };
  selectAgent(agentId: string | null): Promise<void>;
  copyText(text: string): Promise<boolean>;
  setStatus(message: string, isError?: boolean): void;
}

export interface PanelExtension {
  id: string;
  title: string;
  slot: 'right-tab';
  order?: number;
  render(container: HTMLElement, ctx: ClientContext): void | (() => void);
}

export interface ArtifactAction {
  id: string;
  label: string;
  run(entry: ArtifactEntry, ctx: ClientContext): Promise<void> | void;
}

export interface ArtifactRenderer {
  id: string;
  matches(entry: ArtifactEntry): boolean;
  actions?(entry: ArtifactEntry, ctx: ClientContext): ArtifactAction[];
}

export interface AgentDecorator {
  id: string;
  order?: number;
  render(agent: AgentSummary, ctx: ClientContext): HTMLElement | null;
}

export interface BuiltInExtensionsOptions {
  getArtifacts(): ArtifactEntry[];
  getUploadedPath(): string;
  getUploadStatus(): { message: string; isError: boolean };
  uploadImage(file: File): Promise<void>;
}

export class ExtensionRegistry {
  private readonly panels: PanelExtension[] = [];
  private readonly artifactRenderers: ArtifactRenderer[] = [];
  private readonly decorators: AgentDecorator[] = [];

  registerPanel(extension: PanelExtension): void {
    this.panels.push(extension);
  }

  getPanels(slot: 'right-tab' = 'right-tab'): readonly PanelExtension[] {
    return [...this.panels]
      .filter((panel) => panel.slot === slot)
      .sort(compareByOrderThenId);
  }

  registerArtifactRenderer(renderer: ArtifactRenderer): void {
    this.artifactRenderers.push(renderer);
  }

  getArtifactRenderer(entry: ArtifactEntry): ArtifactRenderer | undefined {
    return this.artifactRenderers.find((renderer) => renderer.matches(entry));
  }

  registerAgentDecorator(decorator: AgentDecorator): void {
    this.decorators.push(decorator);
  }

  getAgentDecorators(): readonly AgentDecorator[] {
    return [...this.decorators].sort(compareByOrderThenId);
  }
}

export function registerBuiltInExtensions(
  registry: ExtensionRegistry,
  ctx: ClientContext,
  options: BuiltInExtensionsOptions,
): void {
  registry.registerPanel({
    id: 'artifacts',
    title: 'Artifacts',
    slot: 'right-tab',
    order: 0,
    render: (container) => {
      renderArtifactsPanel(container, registry, ctx, options);
    },
  });

  registry.registerArtifactRenderer({
    id: 'default-artifact',
    matches: () => true,
    actions: (entry) => {
      const actions = [] as Array<{ id: string; label: string; run: () => Promise<void> | void }>;

      if (entry.kind === 'html') {
        actions.push({
          id: 'open',
          label: 'Open',
          run: () => {
            const agent = ctx.getSelectedAgent();
            if (!agent) return;
            const href = `/artifacts/${encodeURIComponent(agent.id)}/${encodeArtifactPath(entry.relPath)}`;
            window.open(href, '_blank', 'noopener,noreferrer');
          },
        });
      }

      actions.push(
        {
          id: 'copy-path',
          label: 'Copy path',
          run: async () => {
            const copied = await ctx.copyText(entry.absPath);
            ctx.setStatus(copied ? 'Copied full path.' : 'Could not copy path.', !copied);
          },
        },
        {
          id: 'insert-path',
          label: 'Insert path',
          run: () => {
            ctx.terminals.insertText(entry.absPath);
            ctx.setStatus('Inserted path into terminal input.');
          },
        },
      );

      return actions.map((action) => ({
        id: action.id,
        label: action.label,
        run: () => action.run(),
      }));
    },
  });
}

function renderArtifactsPanel(
  container: HTMLElement,
  registry: ExtensionRegistry,
  ctx: ClientContext,
  options: BuiltInExtensionsOptions,
): void {
  const root = document.createElement('div');
  root.className = 'panel-view';

  const uploadPanel = document.createElement('div');
  uploadPanel.className = 'upload-panel';

  const uploadActions = document.createElement('div');
  uploadActions.className = 'upload-actions';

  const chooseImageButton = document.createElement('button');
  chooseImageButton.type = 'button';
  chooseImageButton.textContent = 'Choose image';

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
  imageInput.hidden = true;

  chooseImageButton.addEventListener('click', () => {
    imageInput.click();
  });

  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (file) runTask(options.uploadImage(file));
  });

  uploadActions.append(chooseImageButton, imageInput);

  const pasteTarget = document.createElement('div');
  pasteTarget.className = 'paste-target';
  pasteTarget.tabIndex = 0;
  pasteTarget.textContent = 'Paste image here';
  pasteTarget.addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      ctx.setStatus('Clipboard does not contain an image.', true);
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      ctx.setStatus('Could not read image from clipboard.', true);
      return;
    }
    event.preventDefault();
    runTask(options.uploadImage(file));
  });

  const uploadStatus = document.createElement('div');
  uploadStatus.className = 'muted-text';
  uploadStatus.textContent = options.getUploadStatus().message;
  uploadStatus.style.color = options.getUploadStatus().isError ? 'var(--danger)' : '';

  uploadPanel.append(uploadActions, pasteTarget, uploadStatus);

  const uploadedPath = options.getUploadedPath();
  if (uploadedPath) {
    const uploadedPathRow = document.createElement('div');
    uploadedPathRow.className = 'uploaded-path-row';

    const uploadedPathText = document.createElement('div');
    uploadedPathText.className = 'path-text';
    uploadedPathText.textContent = uploadedPath;

    const rowActions = document.createElement('div');
    rowActions.className = 'row-actions compact-actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Copy path';
    copyButton.addEventListener('click', async () => {
      const copied = await ctx.copyText(uploadedPath);
      ctx.setStatus(copied ? 'Copied full path.' : 'Could not copy path.', !copied);
    });

    const insertButton = document.createElement('button');
    insertButton.type = 'button';
    insertButton.textContent = 'Insert path';
    insertButton.addEventListener('click', () => {
      ctx.terminals.insertText(uploadedPath);
      ctx.setStatus('Inserted path into terminal input.');
    });

    rowActions.append(copyButton, insertButton);
    uploadedPathRow.append(uploadedPathText, rowActions);
    uploadPanel.append(uploadedPathRow);
  }

  const artifactList = document.createElement('div');
  artifactList.className = 'artifact-list';
  renderArtifactList(artifactList, registry, ctx, options.getArtifacts());

  root.append(uploadPanel, artifactList);
  container.append(root);
}

function renderArtifactList(
  container: HTMLDivElement,
  registry: ExtensionRegistry,
  ctx: ClientContext,
  artifacts: ArtifactEntry[],
): void {
  const agent = ctx.getSelectedAgent();
  if (!agent) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select an agent to browse .miru artifacts.';
    container.append(empty);
    return;
  }

  if (artifacts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No artifacts yet.';
    container.append(empty);
    return;
  }

  for (const entry of artifacts) {
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
    meta.textContent = `${new Date(entry.mtimeMs).toLocaleString()} · ${formatBytes(entry.size)}`;

    main.append(nameLine, meta);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'artifact-actions';

    const renderer = registry.getArtifactRenderer(entry);
    const actions = renderer?.actions?.(entry, ctx) ?? [];
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        runTask(Promise.resolve().then(() => action.run(entry, ctx)));
      });
      actionsEl.append(button);
    }

    row.append(main, actionsEl);
    container.append(row);
  }
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

function compareByOrderThenId<T extends { id: string; order?: number }>(a: T, b: T): number {
  return (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
}

function runTask(task: Promise<unknown>): void {
  task.catch((error) => {
    console.error(error);
  });
}
