import type * as pty from 'node-pty';

interface Osc52State {
  inOsc: boolean;
  oscData: string;
  pendingEsc: boolean;
}

export interface TerminalSessionCallbacks {
  onData(data: string): void;
  onClipboardCopy(text: string): void;
  onExit(exitCode: number | null): void;
}

export interface TerminalSessionOptions {
  bufferLimit?: number;
  minCols?: number;
  minRows?: number;
}

export class TerminalSession {
  private readonly callbacks: TerminalSessionCallbacks;
  private readonly bufferLimit: number;
  private readonly minCols: number;
  private readonly minRows: number;
  private readonly osc52: Osc52State = {
    inOsc: false,
    oscData: '',
    pendingEsc: false,
  };
  private buffer = '';

  constructor(
    private readonly ptyProcess: pty.IPty,
    callbacks: TerminalSessionCallbacks,
    options: TerminalSessionOptions = {},
  ) {
    this.callbacks = callbacks;
    this.bufferLimit = options.bufferLimit ?? 512 * 1024;
    this.minCols = options.minCols ?? 20;
    this.minRows = options.minRows ?? 6;

    this.ptyProcess.onData((chunk) => {
      const processed = extractOsc52(this.osc52, chunk);
      if (processed.displayData) {
        this.buffer += processed.displayData;
        if (this.buffer.length > this.bufferLimit) {
          this.buffer = this.buffer.slice(this.buffer.length - this.bufferLimit);
        }
        this.callbacks.onData(processed.displayData);
      }

      for (const text of processed.clipboardTexts) {
        this.callbacks.onClipboardCopy(text);
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.callbacks.onExit(exitCode);
    });
  }

  write(data: string | Buffer): void {
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(this.minCols, Math.floor(cols));
    const safeRows = Math.max(this.minRows, Math.floor(rows));
    this.ptyProcess.resize(safeCols, safeRows);
  }

  getBuffer(): string {
    return this.buffer;
  }

  kill(): void {
    this.ptyProcess.kill();
  }
}

const OSC = ']';
const BEL = '\x07';
const ESC = '\x1b';
const ST = '\x1b\\';
const MAX_OSC52_BASE64_LENGTH = 1024 * 1024;

function extractOsc52(state: Osc52State, chunk: string): { displayData: string; clipboardTexts: string[] } {
  let displayData = '';
  const clipboardTexts: string[] = [];
  let index = 0;

  if (state.pendingEsc) {
    state.pendingEsc = false;
    if (state.inOsc) {
      if (chunk.startsWith('\\')) {
        const completed = completeOsc(state, ST);
        displayData += completed.displayData;
        if (completed.clipboardText != null) clipboardTexts.push(completed.clipboardText);
        index = 1;
      } else {
        state.oscData += ESC;
      }
    } else if (chunk.startsWith(OSC)) {
      state.inOsc = true;
      state.oscData = '';
      index = 1;
    } else {
      displayData += ESC;
    }
  }

  while (index < chunk.length) {
    const char = chunk[index];

    if (!state.inOsc) {
      if (char === ESC) {
        if (index + 1 >= chunk.length) {
          state.pendingEsc = true;
          break;
        }
        if (chunk[index + 1] === OSC) {
          state.inOsc = true;
          state.oscData = '';
          index += 2;
          continue;
        }
      }
      displayData += char;
      index += 1;
      continue;
    }

    if (char === BEL) {
      const completed = completeOsc(state, BEL);
      displayData += completed.displayData;
      if (completed.clipboardText != null) clipboardTexts.push(completed.clipboardText);
      index += 1;
      continue;
    }

    if (char === ESC) {
      if (index + 1 >= chunk.length) {
        state.pendingEsc = true;
        break;
      }
      if (chunk[index + 1] === '\\') {
        const completed = completeOsc(state, ST);
        displayData += completed.displayData;
        if (completed.clipboardText != null) clipboardTexts.push(completed.clipboardText);
        index += 2;
        continue;
      }
    }

    state.oscData += char;
    index += 1;
  }

  return { displayData, clipboardTexts };
}

function completeOsc(state: Osc52State, terminator: string): { displayData: string; clipboardText?: string } {
  const rawData = state.oscData;
  state.inOsc = false;
  state.oscData = '';

  const firstSeparator = rawData.indexOf(';');
  const secondSeparator = firstSeparator < 0 ? -1 : rawData.indexOf(';', firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0 || rawData.slice(0, firstSeparator) !== '52') {
    return { displayData: `${ESC}${OSC}${rawData}${terminator}` };
  }

  const payload = rawData.slice(secondSeparator + 1);
  if (payload === '?') {
    return { displayData: '' };
  }

  const clipboardText = decodeOsc52Payload(payload);
  return clipboardText == null ? { displayData: '' } : { displayData: '', clipboardText };
}

function decodeOsc52Payload(payload: string): string | null {
  if (payload.length > MAX_OSC52_BASE64_LENGTH) {
    return null;
  }

  try {
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
