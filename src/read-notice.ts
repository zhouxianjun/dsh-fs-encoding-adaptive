import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import { RG_ENCODING_LABELS } from './encoding/index.js';
import type { EncodingRecord } from './encoding/index.js';
import type { EncodingAdaptiveLocalFileSystem } from './fs/index.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fs-encoding-adaptive': {
      readonly kind: 'fs-encoding-adaptive';
    } & ContextFormed;
  }
}

/**
 * Formats the post-read encoding notice injected for non-UTF-8 files.
 */
export function formatEncodingNotice(filePath: string, rec: EncodingRecord): string {
  const bomNote = rec.hasBom ? ', BOM' : '';
  const confidenceGate = rec.confident
    ? ''
    : ` [low confidence — mutations are refused until an encodings override is configured for "${filePath}"]`;
  const header = `File "${filePath}" was decoded from ${rec.encoding}${bomNote} (ripgrep label: ${RG_ENCODING_LABELS[rec.encoding]}, EOL: ${rec.eol.toUpperCase()}, source: ${rec.source})${confidenceGate}.`;

  const eolRule =
    rec.eol === 'mixed'
      ? `${rec.confident ? 'Targeted edits' : 'Once configured, targeted edits still'} refuse mixed line endings; full-file overwrites preserve ${rec.hasBom ? 'its original encoding and BOM' : 'its original encoding'} (using the written line endings)`
      : `${rec.confident ? 'Edits and overwrites' : 'Once configured, edits and overwrites'} (including full-file writes) preserve ${rec.hasBom ? 'its original encoding, BOM, and line endings' : 'its original encoding and line endings'}`;

  return `${header} ${eolRule}, with strict lossless round-trip verification (rejecting unmappable characters without modifying the file).`;
}

async function resolveReadTarget(ctx: Context, filePath: string, agent: unknown) {
  const fsService = (ctx as Context & { get(key: 'fs'): FileSystem | undefined }).get('fs');
  if (!fsService) {
    return undefined;
  }

  let cwd: string | undefined;
  const wd = (
    ctx as Context & {
      get(
        key: 'workingDirectory',
      ): { ensure?: (agent: unknown) => Promise<string | undefined> } | undefined;
    }
  ).get('workingDirectory');
  if (agent !== undefined && wd?.ensure) {
    cwd = await wd.ensure(agent).catch(() => undefined);
  }

  return await fsService.resolve(filePath, cwd !== undefined ? { cwd } : undefined);
}

function extractReadPath(toolName: string, args: unknown): string | undefined {
  const parsed = args as
    | { file_path?: unknown; filePath?: unknown; command?: unknown; path?: unknown }
    | undefined;
  if (toolName === 'read') {
    if (typeof parsed?.file_path === 'string') {
      return parsed.file_path;
    }
    if (typeof parsed?.filePath === 'string') {
      return parsed.filePath;
    }
    return undefined;
  }
  if (
    toolName === 'str_replace_editor' &&
    parsed?.command === 'view' &&
    typeof parsed.path === 'string'
  ) {
    return parsed.path;
  }
  return undefined;
}

/**
 * Attaches an encoding notice context message after successful `read` or
 * `str_replace_editor` (`view`) calls on non-UTF-8 files.
 */
export function registerReadEncodingNotice(
  ctx: Context,
  getActiveFs: () => EncodingAdaptiveLocalFileSystem | undefined,
): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'read' && exec.name !== 'str_replace_editor') {
      return await next();
    }

    const decision = await next();
    const activeFs = getActiveFs();
    if (result.isError || decision.kind !== 'accept' || !activeFs) {
      return decision;
    }

    const rawPath = extractReadPath(exec.name, exec.arguments);
    if (!rawPath) {
      return decision;
    }

    let target;
    try {
      target = await resolveReadTarget(ctx, rawPath, exec.agent);
    } catch {
      return decision;
    }
    if (!target) {
      return decision;
    }

    const rec = activeFs.encodingCache.getLatest(target.targetKey);
    if (!rec) {
      return decision;
    }

    const notice = createUserMessage({
      content: [{ type: 'text', text: formatEncodingNotice(target.displayPath, rec) }],
      source: {
        kind: 'fs-encoding-adaptive',
        form: 'notice',
        summary: `Decoded ${target.displayPath} as ${rec.encoding} (${rec.eol.toUpperCase()})`,
      },
    });

    return {
      ...decision,
      additionalContexts: [...(decision.additionalContexts ?? []), notice],
    };
  });
}
