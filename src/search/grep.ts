import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  SearchError,
  buildGrepCommand,
  parseGrepArgs,
  parseGrepMatches,
  runRipgrep,
  toWorkdirRelative,
} from '@deepseek-ai/dsh-tool-fs-search';
import type { GrepInput, GrepMatch } from '@deepseek-ai/dsh-tool-fs-search';
import type { NonUtf8Encoding } from '../encoding/index.js';
import { RG_ENCODING_LABELS } from '../encoding/index.js';
import type { SearchFileInspection } from './inspect.js';

interface CandidateFile {
  readonly candPath: string;
  readonly absPath: string;
  readonly relPath: string;
}

const MAX_FILES_PER_RG_BATCH = 100;
const MAX_ARGS_BYTES_PER_RG_BATCH = 16384;

function buildPrefilterArgv(input: GrepInput): string[] {
  const base = buildGrepCommand({
    pattern: '(?-u)[\\x00\\x80-\\xFF]',
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.include !== undefined ? { include: input.include } : {}),
  });
  // Replace leading '--json' with '--files-with-matches --null --text'
  return ['--files-with-matches', '--null', '--text', ...base.slice(1)];
}

export function batchCandidateFiles<T extends { readonly candPath: string }>(
  files: readonly T[],
  maxFiles = MAX_FILES_PER_RG_BATCH,
  maxBytes = MAX_ARGS_BYTES_PER_RG_BATCH,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const argBytes = Buffer.byteLength(file.candPath, 'utf8') + 1;
    if (current.length > 0 && (current.length >= maxFiles || currentBytes + argBytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += argBytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function buildEncodingGroupArgv(
  input: GrepInput,
  encoding: NonUtf8Encoding,
  files: readonly CandidateFile[],
): string[] {
  const base = buildGrepCommand({
    pattern: input.pattern,
    ...(input.include !== undefined ? { include: input.include } : {}),
  });
  return [
    `--encoding=${RG_ENCODING_LABELS[encoding]}`,
    ...base,
    '--',
    ...files.map((f) => f.candPath),
  ];
}

function mergeGrepMatches(
  origMatches: readonly GrepMatch[],
  nonUtf8Paths: ReadonlySet<string>,
  nonUtf8MatchesByPath: ReadonlyMap<string, GrepMatch[]>,
): GrepMatch[] {
  const merged: GrepMatch[] = [];
  const emittedPaths = new Set<string>();

  for (const m of origMatches) {
    if (!nonUtf8Paths.has(m.path)) {
      merged.push(m);
      continue;
    }
    // Replace any partial ASCII matches from official UTF-8 grep in-place at first occurrence.
    if (!emittedPaths.has(m.path)) {
      emittedPaths.add(m.path);
      const replacement = nonUtf8MatchesByPath.get(m.path);
      if (replacement) {
        merged.push(...replacement);
      }
    }
  }

  // Append newly matched non-UTF-8 files not present in origMatches in deterministic order.
  const remaining = [...nonUtf8MatchesByPath.keys()].filter((p) => !emittedPaths.has(p)).sort();
  for (const p of remaining) {
    const group = nonUtf8MatchesByPath.get(p);
    if (group) {
      merged.push(...group);
    }
  }

  return merged;
}

/**
 * Intercepts `grep` tool calls on `tools/execute`:
 * 1. Lets official UTF-8 `grep` run first (`next()`).
 * 2. Pre-filters files containing high bytes (`0x80..0xFF`) via ripgrep so pure-ASCII
 *    and UTF-8 files incur zero extra Node file I/O.
 * 3. Re-searches detected non-UTF-8 files grouped by `--encoding=<label>` and merges
 *    their matches into `result.value.matches`, letting DSH's output pipeline re-render
 *    and handle the 250-match inline cap + formatted spill automatically.
 */
export function registerGrepHook(
  ctx: Context,
  inspectFile: (
    realPath: string,
    displayPath: string,
    signal?: AbortSignal,
  ) => Promise<SearchFileInspection>,
): void {
  ctx.inject(['subprocess', 'tools'], (hookCtx) => {
    const rgCtx = hookCtx.root;
    hookCtx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
      if (exec.name !== 'grep') {
        return await next();
      }

      const result = await next();
      if (result.isError) {
        return result;
      }

      let input: GrepInput;
      try {
        input = parseGrepArgs(
          exec.arguments as { pattern: string; path?: string; include?: string },
        );
      } catch {
        return result;
      }

      const prefilterArgv = buildPrefilterArgv(input);
      const prefilterRun = await runRipgrep(
        rgCtx,
        exec as ToolExecution,
        'grep',
        prefilterArgv,
        RAW_OUTPUT_MAX_BYTES,
        SEARCH_GRACE_MS,
        SEARCH_STDERR_MAX_BYTES,
      );

      if (prefilterRun.noMatches || !prefilterRun.stdout) {
        return result;
      }

      const rawPaths = [
        ...new Set(prefilterRun.stdout.split('\0').filter((s) => s.length > 0)),
      ].sort();
      if (rawPaths.length === 0) {
        return result;
      }

      const filesByEncoding = new Map<NonUtf8Encoding, CandidateFile[]>();
      const nonUtf8RelPaths = new Set<string>();

      for (const candPath of rawPaths) {
        if (exec.signal.aborted) {
          throw new SearchError(
            'grep was aborted before completion (tool timeout or caller cancellation)',
            'SEARCH_ABORTED',
          );
        }
        const absPath = path.isAbsolute(candPath)
          ? path.resolve(candPath)
          : path.resolve(prefilterRun.workdir, candPath);
        const relPath = toWorkdirRelative(candPath, prefilterRun.workdir);
        let inspection: SearchFileInspection;
        try {
          inspection = await inspectFile(absPath, absPath, exec.signal);
        } catch (err) {
          if ((err instanceof FsError && err.code === 'FS_ABORTED') || exec.signal.aborted) {
            throw new SearchError(
              'grep was aborted before completion (tool timeout or caller cancellation)',
              'SEARCH_ABORTED',
            );
          }
          throw err;
        }
        if (inspection.kind !== 'non-utf8') {
          continue;
        }

        nonUtf8RelPaths.add(relPath);
        const bucket = filesByEncoding.get(inspection.encoding);
        const entry: CandidateFile = { candPath, absPath, relPath };
        if (bucket) {
          bucket.push(entry);
        } else {
          filesByEncoding.set(inspection.encoding, [entry]);
        }
      }

      if (filesByEncoding.size === 0) {
        return result;
      }

      const nonUtf8MatchesByPath = new Map<string, GrepMatch[]>();
      for (const [enc, files] of filesByEncoding) {
        for (const batch of batchCandidateFiles(files)) {
          if (exec.signal.aborted) {
            throw new SearchError(
              'grep was aborted before completion (tool timeout or caller cancellation)',
              'SEARCH_ABORTED',
            );
          }
          const encArgv = buildEncodingGroupArgv(input, enc, batch);
          const encRun = await runRipgrep(
            rgCtx,
            exec as ToolExecution,
            'grep',
            encArgv,
            RAW_OUTPUT_MAX_BYTES,
            SEARCH_GRACE_MS,
            SEARCH_STDERR_MAX_BYTES,
          );
          if (encRun.noMatches || !encRun.stdout) {
            continue;
          }

          const parsed = parseGrepMatches(encRun.stdout);
          for (const m of parsed) {
            const normalizedPath = toWorkdirRelative(m.path, encRun.workdir);
            const match: GrepMatch = {
              path: normalizedPath,
              lineNumber: m.lineNumber,
              line: m.line,
            };
            const existing = nonUtf8MatchesByPath.get(normalizedPath);
            if (existing) {
              existing.push(match);
            } else {
              nonUtf8MatchesByPath.set(normalizedPath, [match]);
            }
          }
        }
      }

      const origMatches = ((result.value as { matches?: GrepMatch[] } | undefined)?.matches ??
        []) as readonly GrepMatch[];
      const mergedMatches = mergeGrepMatches(origMatches, nonUtf8RelPaths, nonUtf8MatchesByPath);

      if (
        mergedMatches.length === origMatches.length &&
        mergedMatches.every((m, idx) => {
          const o = origMatches[idx]!;
          return m.path === o.path && m.lineNumber === o.lineNumber && m.line === o.line;
        })
      ) {
        return result;
      }

      const jsonMatches: { [key: string]: JsonValue }[] = mergedMatches.map((m) => ({
        path: m.path,
        lineNumber: m.lineNumber,
        line: m.line,
      }));

      return {
        isError: false,
        value: { matches: jsonMatches },
        content: [],
        ...(result.additionalContexts ? { additionalContexts: result.additionalContexts } : {}),
        ...(result.concludesTurn ? { concludesTurn: true } : {}),
      };
    });
  });
}
