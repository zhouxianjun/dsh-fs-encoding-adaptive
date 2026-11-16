/**
 * Sandbox path-containment and target-fencing helpers synced from
 * `@deepseek-ai/dsh-fs-sandbox@0.2.2-rc.1` (`src/containment.ts` + `checkedTarget`).
 *
 * Kept verbatim in structure so upstream updates to `@deepseek-ai/dsh-fs-sandbox`
 * can be diffed and merged directly without touching encoding logic.
 *
 * Public seams used: `FileSystem.resolve`, `FsError`, `writableRoots`.
 */

import { stat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import { writableRoots } from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && MISSING_CODES.has(code);
}

function comparablePath(targetPath: string, caseSensitive: boolean): string {
  return caseSensitive ? targetPath : targetPath.toLowerCase();
}

function isLexicallyUnder(targetPath: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(targetPath, caseSensitive);
  const comparableRoot = comparablePath(root, caseSensitive);
  if (comparableTarget === comparableRoot) {
    return true;
  }
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

async function statIfPresent(targetPath: string) {
  try {
    return await stat(targetPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Determine whether a canonical target is a writable root or lies beneath it.
 * Recognizes Windows long-name/8.3 aliases via ancestor dev/ino comparison.
 */
export async function isPathUnder(
  targetPath: string,
  root: string,
  caseSensitive: boolean = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(targetPath, root, caseSensitive)) {
    return true;
  }
  const rootInfo = await statIfPresent(root);
  if (!rootInfo) {
    return false;
  }
  let ancestor = targetPath;
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor);
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) {
      return true;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

/**
 * Enforce the per-call sandbox policy against `target` and return the fresh
 * re-canonicalized target to mutate (preventing check-here-write-there TOCTOU).
 */
export async function checkedTarget(
  fsBackend: Pick<FileSystem, 'resolve'>,
  target: FsTarget,
  resolveFallbackPolicy: () => SandboxExecutionPolicy,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<FsTarget> {
  const policy = sandboxPolicy ?? resolveFallbackPolicy();
  const { mode } = policy;
  if (mode === 'danger-full-access') {
    return target;
  }
  if (mode === 'read-only') {
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under read-only mode`,
      'FS_SANDBOX_DENIED',
    );
  }
  const fresh = await fsBackend.resolve(target.displayPath);
  let contained = false;
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) {
      contained = true;
      break;
    }
  }
  if (!contained) {
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      'FS_SANDBOX_DENIED',
    );
  }
  return fresh;
}
