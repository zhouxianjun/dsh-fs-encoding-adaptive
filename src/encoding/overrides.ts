import * as path from 'node:path';
import { normalizeOverrideEncoding } from './codecs.js';
import type { SupportedTextEncoding } from './codecs.js';

export interface CompiledEncodingOverride {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly basenameOnly: boolean;
  readonly encoding: SupportedTextEncoding;
}

/**
 * Compiles glob-to-encoding rules in declaration order.
 *
 * Rules are evaluated with later-declaration precedence (`matchEncodingOverride`
 * scans in reverse), so narrower `'utf8'` exemptions must be declared after
 * broader non-UTF-8 patterns (for example `{"*.txt": "gbk", "README.txt": "utf8"}`).
 * Unrecognized encoding names are reported via `onInvalid` and skipped.
 */
export function compileEncodingOverrides(
  overrides: Record<string, string> | undefined,
  onInvalid?: (pattern: string, rawEncoding: string) => void,
): CompiledEncodingOverride[] {
  if (!overrides) {
    return [];
  }
  const compiled: CompiledEncodingOverride[] = [];
  for (const [pattern, rawEnc] of Object.entries(overrides)) {
    const enc = normalizeOverrideEncoding(rawEnc);
    if (!enc) {
      onInvalid?.(pattern, rawEnc);
      continue;
    }
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    compiled.push({
      pattern: normalizedPattern,
      regex: globToRegExp(normalizedPattern),
      basenameOnly: !normalizedPattern.includes('/'),
      encoding: enc,
    });
  }
  return compiled;
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.+/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

export function matchEncodingOverride(
  filePath: string,
  overrides: readonly CompiledEncodingOverride[],
  cwd?: string,
): SupportedTextEncoding | undefined {
  if (overrides.length === 0) {
    return undefined;
  }
  const normalizedPath = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalizedPath);
  let relPath: string | undefined;
  if (cwd !== undefined && path.isAbsolute(filePath)) {
    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    if (rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel)) {
      relPath = rel;
    }
  }
  const stripped = normalizedPath.replace(/^\/+/, '');
  for (let i = overrides.length - 1; i >= 0; i--) {
    const rule = overrides[i]!;
    if (rule.basenameOnly) {
      if (rule.regex.test(base)) {
        return rule.encoding;
      }
    } else {
      if (
        (relPath !== undefined && rule.regex.test(relPath)) ||
        rule.regex.test(normalizedPath) ||
        rule.regex.test(stripped)
      ) {
        return rule.encoding;
      }
    }
  }
  return undefined;
}
