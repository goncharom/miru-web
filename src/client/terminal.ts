import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ClientEvent } from '../shared/protocol';

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

export interface TerminalTransport {
  send(event: ClientEvent): void;
  refresh(agentId: string): Promise<void>;
  loadBuffer(agentId: string): Promise<string>;
}

export class TerminalController {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly resizeObserver: ResizeObserver | null;
  private selectedAgentId: string | null = null;
  private readonly onWindowResize = () => this.fitSelected();

  constructor(
    private readonly rootEl: HTMLDivElement,
    private readonly transport: TerminalTransport,
  ) {
    window.addEventListener('resize', this.onWindowResize);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.fitSelected();
      });
      this.resizeObserver.observe(this.rootEl);
    } else {
      this.resizeObserver = null;
    }
  }

  async ensure(agentId: string | null): Promise<void> {
    if (!agentId) return;

    const terminalState = this.ensureTerminalState(agentId);
    if (terminalState.initialized || terminalState.initializing) {
      if (terminalState.initialized && this.selectedAgentId === agentId) {
        this.focusTerminal(agentId);
      }
      return;
    }

    terminalState.initializing = true;
    terminalState.queuedChunks = [];
    const initVersion = ++terminalState.initVersion;

    try {
      try {
        await this.transport.refresh(agentId);
      } catch (error) {
        console.warn('Could not refresh terminal mirror before initialization.', error);
      }

      const buffer = await this.transport.loadBuffer(agentId);
      if (terminalState.initVersion !== initVersion) {
        return;
      }
      terminalState.terminal.reset();
      terminalState.terminal.write(buffer || '');
      for (const chunk of terminalState.queuedChunks) {
        terminalState.terminal.write(chunk);
      }
      terminalState.initialized = true;
      terminalState.queuedChunks = [];
      if (this.selectedAgentId === agentId) {
        this.focusTerminal(agentId);
      }
    } finally {
      if (terminalState.initVersion === initVersion) {
        terminalState.initializing = false;
      }
    }
  }

  select(agentId: string | null): void {
    this.selectedAgentId = agentId;
    for (const [currentId, terminalState] of this.terminals) {
      terminalState.container.classList.toggle('active', currentId === agentId);
    }

    if (agentId) {
      this.focusTerminal(agentId);
    }
  }

  remove(agentId: string): void {
    const terminalState = this.terminals.get(agentId);
    if (!terminalState) return;
    terminalState.terminal.dispose();
    terminalState.container.remove();
    this.terminals.delete(agentId);
    if (this.selectedAgentId === agentId) {
      this.selectedAgentId = null;
    }
  }

  prune(validAgentIds: string[]): void {
    const validIds = new Set(validAgentIds);
    for (const agentId of Array.from(this.terminals.keys())) {
      if (!validIds.has(agentId)) {
        this.remove(agentId);
      }
    }
  }

  invalidateAll(): void {
    for (const terminalState of this.terminals.values()) {
      terminalState.initialized = false;
      terminalState.initializing = false;
      terminalState.queuedChunks = [];
      terminalState.initVersion += 1;
    }
  }

  handleOutput(agentId: string, data: string): void {
    const terminalState = this.terminals.get(agentId);
    if (!terminalState) return;
    if (terminalState.initialized) {
      terminalState.terminal.write(data);
      return;
    }
    if (terminalState.initializing) {
      terminalState.queuedChunks.push(data);
    }
  }

  async handleClipboardCopy(agentId: string, text: string): Promise<void> {
    if (agentId !== this.selectedAgentId) return;
    const copied = await copyText(text);
    if (!copied) {
      console.warn('Could not copy terminal selection to clipboard.');
    }
  }

  insertText(agentId: string, text: string): void {
    this.transport.send({ type: 'terminal_input', agentId, data: text });
    if (this.selectedAgentId === agentId) {
      this.focusTerminal(agentId);
    }
  }

  fitSelected(): void {
    requestAnimationFrame(() => {
      this.doFitSelected();
      window.setTimeout(() => this.doFitSelected(), 60);
      window.setTimeout(() => this.doFitSelected(), 180);
    });
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    for (const agentId of Array.from(this.terminals.keys())) {
      this.remove(agentId);
    }
  }

  private ensureTerminalState(agentId: string): TerminalState {
    const existing = this.terminals.get(agentId);
    if (existing) return existing;

    const container = document.createElement('div');
    container.className = 'terminal-instance';
    this.rootEl.append(container);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: {
        background: '#000000',
        foreground: '#eae1d0',
        cursor: '#f05d23',
        cursorAccent: '#000000',
        selectionBackground: 'rgba(234, 225, 208, 0.18)',
        selectionInactiveBackground: 'rgba(234, 225, 208, 0.12)',
      },
      scrollback: 10000,
      allowTransparency: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    attachTerminalKeyHandler(terminal, agentId, this.transport);
    attachTerminalPasteHandler(container, terminal, agentId, this.transport);
    terminal.onData((data) => {
      this.transport.send({ type: 'terminal_input', agentId, data });
    });
    terminal.onBinary((data) => {
      this.transport.send({ type: 'terminal_binary', agentId, dataBase64: window.btoa(data) });
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

    this.terminals.set(agentId, terminalState);
    if (this.selectedAgentId === agentId) {
      container.classList.add('active');
    }
    return terminalState;
  }

  private focusTerminal(agentId: string): void {
    const terminalState = this.terminals.get(agentId);
    if (!terminalState) return;
    this.fitSelected();
    terminalState.terminal.focus();
  }

  private doFitSelected(): void {
    const agentId = this.selectedAgentId;
    if (!agentId) return;
    const terminalState = this.terminals.get(agentId);
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

    this.transport.send({
      type: 'terminal_resize',
      agentId,
      cols: terminalState.terminal.cols,
      rows: terminalState.terminal.rows,
    });
  }
}

function attachTerminalKeyHandler(terminal: Terminal, agentId: string, transport: TerminalTransport): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return true;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.type === 'keydown') {
      transport.send({
        type: 'terminal_input',
        agentId,
        data: '\u001b[13;2u',
      });
    }

    return false;
  });
}

function attachTerminalPasteHandler(
  container: HTMLDivElement,
  terminal: Terminal,
  agentId: string,
  transport: TerminalTransport,
): void {
  container.addEventListener(
    'paste',
    (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text || !/[\r\n]/.test(text)) return;

      event.preventDefault();
      event.stopPropagation();
      sendBracketedTerminalPaste(agentId, text, transport);
      terminal.focus();
    },
    { capture: true },
  );
}

function sendBracketedTerminalPaste(agentId: string, text: string, transport: TerminalTransport): void {
  const normalized = text.replace(/\r?\n/g, '\r');
  transport.send({
    type: 'terminal_input',
    agentId,
    data: `\u001b[200~${normalized}\u001b[201~`,
  });
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
