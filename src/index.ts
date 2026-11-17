import { constants as bufferConstants } from 'node:buffer';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { EncodingResolver } from './encoding/index.js';
import {
  EncodingAdaptiveLocalFileSystem,
  EncodingAdaptiveSandboxedFileSystem,
} from './fs/index.js';
import { registerReadEncodingNotice } from './read-notice.js';
import { inspectFileEncodingForSearch, registerGrepHook } from './search/index.js';
import { FsEncodingService } from './service.js';

export * from './encoding/index.js';
export * from './fs/index.js';
export * from './search/index.js';
export * from './read-notice.js';
export * from './service.js';
export * from './upstream/atomic-write.js';
export * from './upstream/sandbox-fence.js';

export const name = 'fs-encoding-adaptive';

const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
);
const DEFAULT_DIFF_BASIS_BYTES = 10 * 1024 * 1024;
const SANDBOX_WAIT_WARN_MS = 5000;

export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Exclusive byte limit per overwrite diff basis side. Defaults to 10 MiB. */
  diffBasisMaxBytes?: number;
  /** Enforce sandboxPolicy confinement (`EncodingAdaptiveSandboxedFileSystem`). Defaults to `true`. */
  sandbox?: boolean;
  /**
   * Glob-to-encoding overrides (e.g. `{"*.csv": "gbk", "README.csv": "utf8"}`).
   * Later declarations take precedence over earlier ones.
   */
  encodings?: Record<string, string>;
  /** Custom encoding resolver callback (`callback > config.encodings > auto-detection`). */
  resolveEncoding?: EncodingResolver;
}

export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  diffBasisMaxBytes: z.natural().min(1).max(MAX_DIFF_BASIS_BYTES).default(DEFAULT_DIFF_BASIS_BYTES),
  sandbox: z.boolean().default(true),
  encodings: z.dict(z.string()).default({}),
  resolveEncoding: z.function() as unknown as z<EncodingResolver>,
});

export function apply(ctx: Context, config: Config): void {
  const diffBasisMaxBytes = config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_BYTES;
  const sandboxEnabled = config.sandbox ?? true;
  let activeFs: EncodingAdaptiveLocalFileSystem | undefined;

  const fsConfig = {
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    diffBasisMaxBytes,
    ...(config.encodings !== undefined ? { encodings: config.encodings } : {}),
    ...(config.resolveEncoding !== undefined ? { resolveEncoding: config.resolveEncoding } : {}),
  };

  if (sandboxEnabled) {
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const clearWaitTimer = () => {
      if (waitTimer !== undefined) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
    };

    const hasSandboxPolicy = Boolean(
      (ctx as Context & { get(key: string): unknown }).get('sandboxPolicy'),
    );
    if (!hasSandboxPolicy) {
      waitTimer = setTimeout(() => {
        waitTimer = undefined;
        ctx
          .logger(name)
          .warn(
            'Still waiting for sandboxPolicy service after 5s; ensure @deepseek-ai/dsh-sandbox-policy is enabled or set sandbox: false.',
          );
      }, SANDBOX_WAIT_WARN_MS);
      waitTimer.unref?.();
    }

    ctx.effect(() => clearWaitTimer);

    ctx.inject(['sandboxPolicy'], (innerCtx) => {
      clearWaitTimer();
      const fsInstance = new EncodingAdaptiveSandboxedFileSystem(innerCtx, fsConfig);
      activeFs = fsInstance;
      new FsEncodingService(innerCtx, () => activeFs);
      innerCtx.effect(() => () => {
        if (activeFs === fsInstance) {
          activeFs = undefined;
        }
      });
    });
  } else {
    const fsInstance = new EncodingAdaptiveLocalFileSystem(ctx, fsConfig);
    activeFs = fsInstance;
    new FsEncodingService(ctx, () => activeFs);
    ctx.effect(() => () => {
      if (activeFs === fsInstance) {
        activeFs = undefined;
      }
    });
  }

  registerGrepHook(ctx, (realPath, displayPath, signal) =>
    inspectFileEncodingForSearch(realPath, displayPath, signal),
  );

  registerReadEncodingNotice(ctx, () => activeFs);
}
