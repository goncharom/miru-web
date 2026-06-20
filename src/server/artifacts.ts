import { promises as fs } from 'node:fs';
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import type { ArtifactEntry, ArtifactKind, UploadImageResult } from '../shared/protocol';
import { ensureDirectory } from './utils';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export interface ArtifactReadResult {
  content: Buffer;
  contentType: string;
}

export interface ArtifactStore {
  list(cwd: string): Promise<ArtifactEntry[]>;
  read(cwd: string, relPath: string): Promise<ArtifactReadResult>;
  saveImage(cwd: string, bytes: Buffer, contentType: string, originalName?: string): Promise<UploadImageResult>;
}

export class LocalArtifactStore implements ArtifactStore {
  async list(cwd: string): Promise<ArtifactEntry[]> {
    const root = await ensureMiruDir(cwd);
    const entries: ArtifactEntry[] = [];
    await walk(root, root, entries);
    entries.sort((a, b) => {
      if (a.kind === 'html' && b.kind !== 'html') return -1;
      if (a.kind !== 'html' && b.kind === 'html') return 1;
      return b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath);
    });
    return entries;
  }

  async read(cwd: string, relPath: string): Promise<ArtifactReadResult> {
    const path = resolveArtifactPath(cwd, relPath);
    const content = await fs.readFile(path);
    return { content, contentType: contentTypeForPath(path) };
  }

  async saveImage(cwd: string, bytes: Buffer, contentType: string, originalName?: string): Promise<UploadImageResult> {
    if (!bytes.length) {
      throw new Error('Uploaded image was empty');
    }

    const miruDir = await ensureMiruDir(cwd);
    const pastedDir = resolve(miruDir, 'pasted');
    await ensureDirectory(pastedDir);

    const extension = extensionForUpload(contentType, originalName);
    if (!extension) {
      throw new Error('Unsupported image type');
    }

    const fileName = `${formatTimestamp(new Date())}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const absolutePath = resolve(pastedDir, fileName);
    await fs.writeFile(absolutePath, bytes);

    return {
      relPath: `pasted/${fileName}`,
      absPath: absolutePath,
    };
  }
}

async function ensureMiruDir(cwd: string): Promise<string> {
  const miruDir = resolve(cwd, '.miru');
  await ensureDirectory(miruDir);
  return miruDir;
}

async function walk(root: string, current: string, entries: ArtifactEntry[]): Promise<void> {
  const children = await fs.readdir(current, { withFileTypes: true });
  for (const child of children) {
    const absolutePath = resolve(current, child.name);
    if (child.isDirectory()) {
      await walk(root, absolutePath, entries);
      continue;
    }
    if (!child.isFile()) continue;
    const stat = await fs.stat(absolutePath);
    const relPath = relative(root, absolutePath).replaceAll('\\', '/');
    entries.push({
      relPath,
      absPath: absolutePath,
      kind: kindForPath(absolutePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
}

function resolveArtifactPath(cwd: string, relPath: string): string {
  const baseDir = resolve(cwd, '.miru');
  const normalizedRel = normalize(decodeURIComponent(relPath)).replace(/^[/\\]+/, '');
  const targetPath = resolve(baseDir, normalizedRel);
  const rel = relative(baseDir, targetPath);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error('Invalid artifact path');
  }
  return targetPath;
}

function extensionForUpload(contentType: string, originalName?: string): string | undefined {
  const direct = IMAGE_EXTENSIONS[contentType.toLowerCase()];
  if (direct) return direct;
  const fromName = extname(originalName ?? '').toLowerCase();
  if (fromName && ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }
  return undefined;
}

function kindForPath(path: string): ArtifactKind {
  const ext = extname(path).toLowerCase();
  if (ext === '.html') return 'html';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  return 'file';
}

export function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function formatTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
