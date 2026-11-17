import { FsError } from '@deepseek-ai/dsh-fs';
import { isSupportedTextEncoding } from './codecs.js';
import type { SupportedTextEncoding } from './codecs.js';
import { matchEncodingOverride } from './overrides.js';
import type { CompiledEncodingOverride } from './overrides.js';

export interface EncodingResolverContext {
  readonly filePath: string;
  readonly realPath?: string;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export type EncodingResolverResult = SupportedTextEncoding | undefined;

export type EncodingResolver = (
  context: EncodingResolverContext,
) => EncodingResolverResult | Promise<EncodingResolverResult>;

export interface ResolvedEncodingPreference {
  readonly encoding: SupportedTextEncoding;
  readonly source: 'callback' | 'override';
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof FsError && error.code === 'FS_ABORTED') {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}

function toAbortedError(filePath: string, cause?: unknown): FsError {
  if (cause instanceof FsError && cause.code === 'FS_ABORTED') {
    return cause;
  }
  return new FsError(
    `Encoding resolution aborted: ${filePath}`,
    'FS_ABORTED',
    cause !== undefined ? { cause } : undefined,
  );
}

/**
 * Resolves a configured encoding preference in precedence order:
 * `callback (resolveEncoding) > config.encodings overrides > undefined (auto-detect)`.
 *
 * Ordinary callback failures or invalid return values log a warning via `onWarn`
 * and fall back to `overrides`. Cancellations always propagate `FS_ABORTED`.
 */
export async function resolveConfiguredEncoding(options: {
  readonly context: EncodingResolverContext;
  readonly resolver?: EncodingResolver | undefined;
  readonly overrides: readonly CompiledEncodingOverride[];
  readonly onWarn?: ((message: string) => void) | undefined;
}): Promise<ResolvedEncodingPreference | undefined> {
  const { context, resolver, overrides, onWarn } = options;

  if (context.signal?.aborted) {
    throw toAbortedError(context.filePath);
  }

  if (resolver) {
    try {
      const candidate = await resolver(context);
      if (context.signal?.aborted) {
        throw toAbortedError(context.filePath);
      }
      if (isSupportedTextEncoding(candidate)) {
        return { encoding: candidate, source: 'callback' };
      }
      if (candidate !== undefined && candidate !== null) {
        onWarn?.(
          `Encoding resolver returned unsupported encoding '${String(candidate)}' for ${context.filePath}; falling back to config.encodings.`,
        );
      }
    } catch (err) {
      if (isAbortLike(err, context.signal)) {
        throw toAbortedError(context.filePath, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      onWarn?.(
        `Encoding resolver threw for ${context.filePath} (${msg}); falling back to config.encodings.`,
      );
    }
  }

  const override = matchEncodingOverride(context.filePath, overrides, context.cwd);
  if (override !== undefined) {
    return { encoding: override, source: 'override' };
  }

  return undefined;
}
