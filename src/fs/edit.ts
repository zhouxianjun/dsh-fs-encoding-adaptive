import { FsError } from '@deepseek-ai/dsh-fs';
import type { FsEditRequest } from '@deepseek-ai/dsh-fs';
import { normalizeEol, normalizeLineEndings } from '../encoding/index.js';
import type { EolStyle } from '../encoding/index.js';

export function isFsNotTextError(err: unknown): err is FsError {
  return err instanceof FsError && err.code === 'FS_NOT_TEXT';
}

export function detectContentEolOrLf(content: string): 'lf' | 'crlf' | 'cr' {
  if (content.includes('\r\n')) {
    return 'crlf';
  }
  if (content.includes('\r')) {
    return 'cr';
  }
  return 'lf';
}

export function applyLiteralEditLf(beforeLf: string, edit: FsEditRequest, eol: EolStyle): string {
  const normalize = eol === 'cr' ? normalizeEol : normalizeLineEndings;
  const oldLf = normalize(edit.oldString);
  const newLf = normalize(edit.newString);
  if (oldLf.length === 0) {
    throw new FsError('oldString must not be empty', 'FS_EDIT_NOT_FOUND');
  }

  const parts: string[] = [];
  let cursor = 0;
  let matchCount = 0;

  while (cursor <= beforeLf.length) {
    const idx = beforeLf.indexOf(oldLf, cursor);
    if (idx === -1) {
      break;
    }
    matchCount++;
    if (!edit.replaceAll && matchCount > 1) {
      throw new FsError(
        `Multiple occurrences of oldString found (${matchCount}+); set replaceAll or provide more context`,
        'FS_AMBIGUOUS_EDIT',
      );
    }
    parts.push(beforeLf.slice(cursor, idx), newLf);
    cursor = idx + oldLf.length;
    if (!edit.replaceAll) {
      break;
    }
  }

  if (matchCount === 0) {
    throw new FsError('oldString not found in target file', 'FS_EDIT_NOT_FOUND');
  }

  if (!edit.replaceAll && beforeLf.indexOf(oldLf, cursor) !== -1) {
    throw new FsError(
      'Multiple occurrences of oldString found; set replaceAll or provide more context',
      'FS_AMBIGUOUS_EDIT',
    );
  }

  parts.push(beforeLf.slice(cursor));
  return parts.join('');
}
