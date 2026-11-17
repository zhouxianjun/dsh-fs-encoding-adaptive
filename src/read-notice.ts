import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-working-directory';
import { RG_ENCODING_LABELS } from './encoding/index.js';
import type { NonUtf8EncodingRecord } from './encoding/index.js';
import type { EncodingAdaptiveLocalFileSystem } from './fs/index.js';

const ENCODING_PROMPT_TOOLS = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'grep',
] as const;

const ENCODING_PROMPT_SECTION_TEXT =
  "Beyond their base UTF-8 tool schemas, `read`, `write`, `edit`, `apply_patch`, `str_replace_editor`, and `grep` are backed by `fs-encoding-adaptive` and support UTF-8 (with or without BOM) and 16 non-UTF-8 encodings (`utf16le`, `utf16be`, `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-kr`, `windows-1250` through `windows-1257`, and `iso-8859-1`). Use these built-in tools directly on files in these encodings instead of shelling out to Python or PowerShell to avoid garbled text. Reading a non-UTF-8 file with `read` or `str_replace_editor` (`view`) attaches an encoding notice with its detected or configured encoding, BOM, and line endings (`LF`, `CRLF`, `CR`, or `MIXED`); in-place edits and writes preserve the file's encoding, BOM, and line endings with strict lossless round-trip verification (use external scripts or create a new target file only when converting between encodings or handling encodings outside the supported 16). `grep` automatically searches both UTF-8 and supported non-UTF-8 files via BOM and byte detection.";

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
export function formatEncodingNotice(filePath: string, rec: NonUtf8EncodingRecord): string {
  const bomNote = rec.hasBom ? ', BOM' : '';
  const confidenceGate = rec.confident
    ? ''
    : ` [low confidence — mutations are refused until an encodings override is configured for "${filePath}"]`;
  const originPhrase =
    rec.source === 'callback' || rec.source === 'override'
      ? `is handled as ${rec.encoding}${bomNote} via rule`
      : `was decoded from ${rec.encoding}${bomNote}`;
  const header = `File "${filePath}" ${originPhrase} (ripgrep label: ${RG_ENCODING_LABELS[rec.encoding]}, EOL: ${rec.eol.toUpperCase()}, source: ${rec.source})${confidenceGate}.`;

  const eolRule =
    rec.eol === 'mixed'
      ? `${rec.confident ? 'Targeted edits' : 'Once configured, targeted edits still'} refuse mixed line endings; under the current filesystem configuration, full-file writes target ${rec.hasBom ? 'this encoding and BOM' : 'this encoding'} (using the written line endings)`
      : `${rec.confident ? 'Under the current filesystem configuration, edits and overwrites' : 'Once configured, edits and overwrites'} (including full-file writes) target ${rec.hasBom ? 'this encoding, BOM, and line endings' : 'this encoding and line endings'}`;

  return `${header} ${eolRule}, with strict lossless round-trip verification (rejecting unmappable characters without modifying the file).`;
}

async function resolveReadTarget(ctx: Context, filePath: string, agent: Agent | undefined) {
  const fsService = ctx.get('fs');
  if (!fsService) {
    return undefined;
  }

  let cwd: string | undefined;
  const wd = ctx.get('workingDirectory');
  if (agent !== undefined && wd) {
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
    if (!rec || rec.encoding === 'utf8') {
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

/**
 * Registers a scope-aware system-prompt section advertising encoding-adaptive
 * capabilities when any supported built-in filesystem or search tool is visible.
 */
export function registerEncodingSystemPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt', 'tools'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tool:fs-encoding-adaptive',
      order: promptCtx.systemPrompt.getSectionOrder('TOOL_GREP') + 10,
      interpolate: false,
      text: ({ scope, toolSet }) =>
        ENCODING_PROMPT_TOOLS.some(
          (name) => promptCtx.tools.get(name, scope, toolSet) !== undefined,
        )
          ? ENCODING_PROMPT_SECTION_TEXT
          : '',
    });
  });
}
