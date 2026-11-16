/**
 * Atomic raw-byte publication and stat-paired byte reads modeled after
 * `@deepseek-ai/dsh-fs-local@0.2.2-rc.2` (`src/fsio.ts`).
 *
 * Unlike `fsio.ts`, version tokens (`FsVersion`) are never synthesized locally:
 * every `statFn` callback delegates to `FileSystem.stat(target)`, ensuring 100%
 * parity with the official `LocalFileSystem` version identity.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';
import type { FsInfo, FsVersion } from '@deepseek-ai/dsh-fs';
import { copyFileDaclWin32, replaceFileWin32 } from './win32.js';

const TMP_DIR_PREFIX = '.dsh-enc-tmp-';
const STALE_TMP_MAX_AGE_MS = 10 * 60 * 1000;
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024;

export interface ReadBytesResult {
  readonly raw: Buffer;
  readonly info: FsInfo;
  readonly mode: number;
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) {
    throw new FsError(`${verb} aborted`, 'FS_ABORTED');
  }
}

/**
 * Local fallback for `@deepseek-ai/dsh-fs` `fsErrorFromErrno` (added in
 * `0.2.2-rc.2`) so the plugin remains compatible with `0.2.2-rc.1` hosts.
 */
export function fsErrorFromErrno(operation: string, displayPath: string, error: unknown): unknown {
  if (
    error instanceof FsError ||
    !(error instanceof Error) ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return error;
  }
  const failure = `cannot ${operation} "${displayPath}"`;
  switch (error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FsError(`${failure}: not found`, 'FS_NOT_FOUND', { cause: error });
    case 'EACCES':
    case 'EPERM':
      return new FsError(`${failure}: permission denied`, 'FS_PERMISSION_DENIED', { cause: error });
    case 'EISDIR':
      return new FsError(`${failure}: not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error });
    default:
      return new FsError(`${failure}: ${error.message}`, 'FS_IO_ERROR', { cause: error });
  }
}

function writeIoError(displayPath: string, error: unknown): unknown {
  if (error instanceof FsError) {
    return error;
  }
  if (isPermissionError(error)) {
    return new FsError(`cannot write "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', {
      cause: error,
    });
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return new FsError(`cannot write "${displayPath}": ${error.message}`, 'FS_IO_ERROR', {
      cause: error,
    });
  }
  return error;
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
): Promise<never> {
  let existing: fs.BigIntStats | undefined;
  try {
    existing = await fs.promises.lstat(absolutePath, { bigint: true });
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new FsError(
        `cannot write "${displayPath}": ${errorMessage(metadataError)}`,
        'FS_IO_ERROR',
        {
          cause: metadataError,
        },
      );
    }
  }

  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new FsError(
        `cannot write "${displayPath}": not a regular file`,
        'FS_NOT_REGULAR_FILE',
        {
          cause: error,
        },
      );
    }
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    );
  }
  if (isEEXIST(error)) {
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    );
  }
  throw new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', {
    cause: error,
  });
}

/**
 * Performs a `stat1 -> readFile -> stat2` read using the backend's own `stat`
 * method so `info.version` comes directly from the parent `LocalFileSystem` and
 * concurrent mid-read mutations fail closed with `FS_STALE_VERSION`.
 */
export async function readBytesWithStat(
  realPath: string,
  statFn: () => Promise<FsInfo | undefined>,
  signal?: AbortSignal,
  displayPath: string = realPath,
): Promise<ReadBytesResult> {
  throwIfAborted(signal, 'read');
  const info1 = await statFn();
  if (!info1) {
    throw new FsError(`cannot read "${displayPath}": not found`, 'FS_NOT_FOUND');
  }
  if (info1.type !== 'file') {
    throw new FsError(`cannot read "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  }

  let st: fs.Stats;
  let raw: Buffer;
  try {
    [st, raw] = await Promise.all([
      fs.promises.stat(realPath),
      fs.promises.readFile(realPath, signal ? { signal } : undefined),
    ]);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new FsError('read aborted', 'FS_ABORTED');
    }
    throw fsErrorFromErrno('read', displayPath, error);
  }

  throwIfAborted(signal, 'read');
  const info2 = await statFn();
  if (!info2 || info2.version !== info1.version) {
    throw new FsError(`File changed while reading: ${displayPath}`, 'FS_STALE_VERSION');
  }

  return { raw, info: info2, mode: st.mode & 0o777 };
}

/**
 * Bounded raw-byte pre-read modeled after `fsio.ts` `readTextForDiff`.
 * Returns `null` when the target is non-regular, at/above `maxBytes`, changed
 * size mid-read, or fails descriptor open/stat/read with an errno (e.g. `0o200`
 * `EACCES`), while still propagating `FS_ABORTED`.
 */
export async function readBoundedBytesIfSmall(
  realPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  throwIfAborted(signal, 'read');
  try {
    const handle = await fs.promises.open(realPath, 'r');
    let buffer: Buffer;
    let total = 0;
    let openedSize = 0;
    try {
      throwIfAborted(signal, 'read');
      const info = await handle.stat();
      throwIfAborted(signal, 'read');
      if (!info.isFile()) {
        return null;
      }
      if (info.size >= maxBytes) {
        return null;
      }
      openedSize = info.size;
      buffer = Buffer.allocUnsafe(openedSize + 1);
      while (total < buffer.length) {
        throwIfAborted(signal, 'read');
        const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, total, length, null);
        if (bytesRead === 0) {
          break;
        }
        total += bytesRead;
      }
    } finally {
      await handle.close();
    }
    throwIfAborted(signal, 'read');
    if (total !== openedSize) {
      return null;
    }
    return buffer.subarray(0, total);
  } catch (error: unknown) {
    if (error instanceof FsError) {
      throw error;
    }
    if (error instanceof Error && 'code' in error) {
      return null;
    }
    throw error;
  }
}

function isProcessDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Best-effort cleanup of abandoned staging directories left behind by dead
 * processes or very old crashed runs. Never fails the caller's write.
 */
export async function cleanupDeadTmpDirs(parentDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TMP_DIR_PREFIX)) {
      continue;
    }
    const rest = entry.name.slice(TMP_DIR_PREFIX.length);
    const dashIdx = rest.indexOf('-');
    const pid = dashIdx > 0 ? Number.parseInt(rest.slice(0, dashIdx), 10) : NaN;
    const fullPath = path.join(parentDir, entry.name);
    let shouldClean = isProcessDead(pid);
    if (!shouldClean) {
      try {
        const st = await fs.promises.stat(fullPath);
        if (now - st.mtimeMs > STALE_TMP_MAX_AGE_MS) {
          shouldClean = true;
        }
      } catch {
        continue;
      }
    }
    if (shouldClean) {
      await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface WriteBytesAtomicOptions {
  readonly displayPath?: string;
  readonly expectedVersion?: FsVersion;
  readonly createOnly?: boolean;
  readonly existingDestination?: boolean;
  readonly mode?: number;
  readonly signal?: AbortSignal;
}

/**
 * Atomically publishes raw bytes to `realPath` via a private `0o700` staging
 * directory in the same parent directory, preserving POSIX mode and Windows
 * DACL, using `link` for `createOnly`, and checking the official version guard
 * prior to `rename` / `ReplaceFileW`.
 */
export async function writeBytesAtomic(
  realPath: string,
  bytes: Buffer,
  statFn: () => Promise<FsInfo | undefined>,
  options: WriteBytesAtomicOptions = {},
): Promise<FsInfo> {
  const displayPath = options.displayPath ?? realPath;
  const existingDestination = options.existingDestination ?? options.mode !== undefined;
  throwIfAborted(options.signal, 'write');

  const parentDir = path.dirname(realPath);
  try {
    await fs.promises.mkdir(parentDir, { recursive: true });
  } catch (error: unknown) {
    throw writeIoError(displayPath, error);
  }
  await cleanupDeadTmpDirs(parentDir).catch(() => {});
  throwIfAborted(options.signal, 'write');

  let modeToApply = options.mode;
  if (modeToApply === undefined && existingDestination) {
    try {
      const existing = await fs.promises.stat(realPath);
      modeToApply = existing.mode & 0o777;
    } catch {
      modeToApply = undefined;
    }
  }

  const tmpDir = path.join(parentDir, `${TMP_DIR_PREFIX}${process.pid}-${crypto.randomUUID()}`);
  const tmpFile = path.join(tmpDir, path.basename(realPath));
  let fh: fs.promises.FileHandle | undefined;
  let stagingCreated = false;

  try {
    await fs.promises.mkdir(tmpDir, { mode: 0o700 });
    stagingCreated = true;
    await fs.promises.chmod(tmpDir, 0o700);

    fh = await fs.promises.open(tmpFile, 'wx', 0o600);
    await fh.chmod(0o600);
    if (process.platform === 'win32' && existingDestination) {
      await copyFileDaclWin32(realPath, tmpFile);
    }
    await fh.writeFile(bytes, options.signal ? { signal: options.signal } : undefined);
    await fh.sync();
    if (modeToApply !== undefined) {
      await fh.chmod(modeToApply);
    }
    await fh.close();
    fh = undefined;

    throwIfAborted(options.signal, 'write');

    if (!options.createOnly && options.expectedVersion !== undefined) {
      const current = await statFn();
      if (!current || current.version !== options.expectedVersion) {
        throw new FsError(
          `Target version changed before commit: ${displayPath}`,
          'FS_STALE_VERSION',
        );
      }
      throwIfAborted(options.signal, 'write');
    }

    if (options.createOnly) {
      try {
        await fs.promises.link(tmpFile, realPath);
      } catch (error: unknown) {
        await throwGuardedCreateFailure(error, realPath, displayPath);
      }
    } else if (process.platform === 'win32' && existingDestination) {
      try {
        await replaceFileWin32(realPath, tmpFile);
      } catch (error: unknown) {
        if (!isENOENT(error)) {
          throw error;
        }
        await fs.promises.rename(tmpFile, realPath);
      }
    } else {
      await fs.promises.rename(tmpFile, realPath);
    }

    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  } catch (error: unknown) {
    let failure: unknown = isAbortError(error)
      ? new FsError('write aborted', 'FS_ABORTED')
      : writeIoError(displayPath, error);
    if (fh) {
      try {
        await fh.close();
      } catch (closeError: unknown) {
        failure = new FsError(
          `write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`,
          'FS_NOT_FOUND',
          { cause: failure },
        );
      }
    }
    if (stagingCreated) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError: unknown) {
        throw new FsError(
          `write failed (${errorMessage(failure)}) and temp cleanup failed (${errorMessage(cleanupError)})`,
          'FS_NOT_FOUND',
          { cause: failure },
        );
      }
    }
    throw failure;
  }

  const published = await statFn();
  if (!published) {
    throw new FsError(
      `Published file vanished immediately after rename: ${displayPath}`,
      'FS_IO_ERROR',
    );
  }
  return published;
}
