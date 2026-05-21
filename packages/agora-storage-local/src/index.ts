// @quarry-systems/agora-storage-local
//
// `LocalStorageProvider` implements the `StorageProvider` contract against a
// local filesystem directory. The on-disk layout mirrors the agora URI:
//
//   agora://<namespace>/<type>/<name>/<contentHash>
//     -> <root>/<namespace>/<type>/<name>/<contentHash>.blob
//
// Per-(namespace, type, name) registry of registered blobs lives at
//   <root>/<namespace>/<type>/<name>/_index.json
// and is the source of truth for `resolveLatest` / `list`.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import {
  parseAgoraUri,
  buildAgoraUri,
  computeContentHash,
  IntegrityMismatchError,
  type StorageProvider,
  type AgoraUriParts,
} from '@quarry-systems/agora-core';

export interface LocalStorageProviderOpts {
  rootDir: string;
}

interface IndexEntry {
  contentHash: string;
  registeredAt: string;
}

interface IndexFile {
  entries: IndexEntry[];
}

function emptyIndex(): IndexFile {
  return { entries: [] };
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local-fs';

  constructor(private opts: LocalStorageProviderOpts) {}

  async put(
    uri: string,
    contents: Uint8Array,
  ): Promise<{ contentHash: string }> {
    const parsed = parseAgoraUri(uri);
    const contentHash = computeContentHash(contents);
    if (parsed.contentHash && parsed.contentHash !== contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, contentHash);
    }

    const blobPath = this.blobPath(parsed, contentHash);
    await mkdir(dirname(blobPath), { recursive: true });
    await writeFile(blobPath, contents);

    const indexPath = this.indexPath(parsed);
    const index = await this.readIndex(indexPath);
    if (!index.entries.some((e) => e.contentHash === contentHash)) {
      index.entries.push({
        contentHash,
        registeredAt: new Date().toISOString(),
      });
      await writeFile(indexPath, JSON.stringify(index, null, 2));
    }

    return { contentHash };
  }

  async get(uri: string): Promise<Uint8Array> {
    const parsed = parseAgoraUri(uri);
    if (!parsed.contentHash) {
      throw new Error(
        `LocalStorageProvider.get requires a pinned URI with contentHash: ${uri}`,
      );
    }
    const blobPath = this.blobPath(parsed, parsed.contentHash);
    const bytes = await readFile(blobPath);
    const actual = computeContentHash(bytes);
    if (actual !== parsed.contentHash) {
      throw new IntegrityMismatchError(parsed.contentHash, actual);
    }
    // Return a plain Uint8Array view (readFile returns a Buffer, which is a
    // Uint8Array subclass — surface the narrower type for the contract).
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async resolveLatest(
    uri: string,
  ): Promise<
    { uri: string; contentHash: string; registeredAt: string } | null
  > {
    const parsed = parseAgoraUri(uri);
    const index = await this.readIndex(this.indexPath(parsed));
    if (index.entries.length === 0) return null;
    let latest = index.entries[0]!;
    for (const e of index.entries) {
      if (e.registeredAt > latest.registeredAt) latest = e;
    }
    return {
      uri: buildAgoraUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: latest.contentHash,
      }),
      contentHash: latest.contentHash,
      registeredAt: latest.registeredAt,
    };
  }

  async list(
    uri: string,
  ): Promise<
    Array<{ uri: string; contentHash: string; registeredAt: string }>
  > {
    const parsed = parseAgoraUri(uri);
    const index = await this.readIndex(this.indexPath(parsed));
    const sorted = [...index.entries].sort((a, b) =>
      a.registeredAt < b.registeredAt
        ? 1
        : a.registeredAt > b.registeredAt
          ? -1
          : 0,
    );
    return sorted.map((e) => ({
      uri: buildAgoraUri({
        namespace: parsed.namespace,
        type: parsed.type,
        name: parsed.name,
        contentHash: e.contentHash,
      }),
      contentHash: e.contentHash,
      registeredAt: e.registeredAt,
    }));
  }

  private blobPath(parts: AgoraUriParts, contentHash: string): string {
    // Content hashes are of the form `sha256:<hex>` — the ":" is not a legal
    // filename character on Windows, so encode it.
    const safeHash = contentHash.replace(':', '_');
    return join(
      this.opts.rootDir,
      parts.namespace,
      parts.type,
      parts.name,
      `${safeHash}.blob`,
    );
  }

  private indexPath(parts: AgoraUriParts): string {
    return join(
      this.opts.rootDir,
      parts.namespace,
      parts.type,
      parts.name,
      '_index.json',
    );
  }

  private async readIndex(indexPath: string): Promise<IndexFile> {
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as IndexFile;
      if (!parsed || !Array.isArray(parsed.entries)) return emptyIndex();
      return parsed;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return emptyIndex();
      }
      throw err;
    }
  }
}
