import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readRequestBody(req);
  return JSON.parse(body.toString('utf8')) as T;
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

export function sendText(res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function sendBuffer(res: ServerResponse, statusCode: number, body: Buffer, contentType: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export async function ensureDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function validateDirectory(path: string): Promise<void> {
  const stat = await fs.stat(path);
  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory');
  }
}

export const MIRU_AGENT_SESSION_PREFIX = 'miru-agent-';

export function makeAgentId(): string {
  return randomUUID().slice(0, 8);
}

export function makeSessionName(agentId: string): string {
  return `${MIRU_AGENT_SESSION_PREFIX}${agentId}`;
}

export function parseAgentIdFromSessionName(sessionName: string): string | undefined {
  if (!sessionName.startsWith(MIRU_AGENT_SESSION_PREFIX)) return undefined;
  const id = sessionName.slice(MIRU_AGENT_SESSION_PREFIX.length).trim();
  return id || undefined;
}

export function folderTagFromCwd(cwd: string): string {
  return basename(cwd) || cwd;
}

export function defaultAgentName(cwd: string): string {
  return folderTagFromCwd(cwd);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
