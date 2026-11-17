import fs from 'node:fs';
import { FsError } from '@deepseek-ai/dsh-fs';
import { decodeAndValidateNonUtf8, isValidUtf8Text } from '../encoding/index.js';
import type { NonUtf8Encoding } from '../encoding/index.js';
import { isFsNotTextError } from '../fs/edit.js';

const SEARCH_SAMPLE_BYTES = 65536;

export type SearchFileInspection =
  | { readonly kind: 'utf8' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'non-utf8'; readonly encoding: NonUtf8Encoding };

function hasNonAsciiOrNul(buf: Buffer): boolean {
  if (buf.includes(0)) {
    return true;
  }
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]! >= 0x80) {
      return true;
    }
  }
  return false;
}

function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length;
  if (len === 0) {
    return buf;
  }
  let i = len - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i]! & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (i < 0) {
    return buf;
  }
  const lead = buf[i]!;
  let expectedLen = 1;
  if ((lead & 0xe0) === 0xc0) {
    expectedLen = 2;
  } else if ((lead & 0xf0) === 0xe0) {
    expectedLen = 3;
  } else if ((lead & 0xf8) === 0xf0) {
    expectedLen = 4;
  } else {
    return buf;
  }
  return len - i < expectedLen ? buf.subarray(0, i) : buf;
}

/**
 * Inspects a file's bytes using BOM/chardet auto-detection for encoding-aware
 * search, independent of filesystem `encodingCache`, `config.encodings`, or
 * `resolveEncoding` callbacks.
 */
export async function inspectFileEncodingForSearch(
  realPath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<SearchFileInspection> {
  if (signal?.aborted) {
    throw new FsError(`Search inspection aborted: ${displayPath}`, 'FS_ABORTED');
  }

  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(realPath, 'r');
    const buf = Buffer.allocUnsafe(SEARCH_SAMPLE_BYTES);
    let sample: Buffer | null = null;
    let truncatedAtWindow = false;

    while (true) {
      if (signal?.aborted) {
        throw new FsError(`Search inspection aborted: ${displayPath}`, 'FS_ABORTED');
      }
      const { bytesRead } = await fh.read(buf, 0, SEARCH_SAMPLE_BYTES, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buf.subarray(0, bytesRead);
      if (hasNonAsciiOrNul(chunk)) {
        sample = Buffer.from(chunk);
        if (bytesRead === SEARCH_SAMPLE_BYTES) {
          const probe = Buffer.allocUnsafe(1);
          const next = await fh.read(probe, 0, 1, null);
          truncatedAtWindow = next.bytesRead > 0;
        }
        break;
      }
    }

    if (sample === null) {
      return { kind: 'utf8' };
    }

    const utf8Candidate = truncatedAtWindow ? trimIncompleteUtf8Tail(sample) : sample;
    if (isValidUtf8Text(utf8Candidate)) {
      return { kind: 'utf8' };
    }

    const trimLimit = truncatedAtWindow ? 3 : 0;
    for (let trim = 0; trim <= trimLimit; trim++) {
      const slice = trim === 0 ? sample : sample.subarray(0, sample.length - trim);
      if (slice.length === 0) {
        break;
      }
      try {
        const decoded = decodeAndValidateNonUtf8(slice, displayPath);
        return { kind: 'non-utf8', encoding: decoded.encoding };
      } catch (err) {
        if (isFsNotTextError(err) && trim < trimLimit) {
          continue;
        }
        return { kind: 'binary' };
      }
    }
    return { kind: 'binary' };
  } catch (err) {
    if ((err instanceof FsError && err.code === 'FS_ABORTED') || signal?.aborted) {
      throw err instanceof FsError
        ? err
        : new FsError(`Search inspection aborted: ${displayPath}`, 'FS_ABORTED');
    }
    return { kind: 'binary' };
  } finally {
    await fh?.close().catch(() => {});
  }
}
