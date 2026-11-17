import { createRequire } from 'node:module';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import type { FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
import type { EncodingResolver } from './encoding/index.js';
import type { CreateTextOptions, EncodingAdaptiveLocalFileSystem } from './fs/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { readonly version?: string };

export const PACKAGE_VERSION: string = pkg.version ?? '0.0.0';

declare module '@deepseek-ai/cordis' {
  interface Context {
    fsEncoding: FsEncodingService;
  }
}

/**
 * Cordis service (`ctx.fsEncoding`) exposing explicit-encoding file creation,
 * package version metadata, dynamic encoding resolver registration, and cache
 * invalidation.
 */
export class FsEncodingService extends Service {
  readonly version: string = PACKAGE_VERSION;

  constructor(
    ctx: Context,
    private readonly getActiveFs: () => EncodingAdaptiveLocalFileSystem | undefined,
  ) {
    super(ctx, 'fsEncoding');
  }

  requireActiveFs(): EncodingAdaptiveLocalFileSystem {
    const activeFs = this.getActiveFs();
    if (!activeFs) {
      throw new FsError('Encoding-adaptive filesystem service is not active', 'FS_IO_ERROR');
    }
    return activeFs;
  }

  async createText(
    target: FsTarget,
    content: string,
    options: CreateTextOptions,
  ): Promise<FsWriteOutcome> {
    return await this.requireActiveFs().createText(target, content, options);
  }

  setEncodingResolver(resolver: EncodingResolver): void {
    this.requireActiveFs().setEncodingResolver(resolver);
  }

  clearEncodingResolver(): void {
    this.requireActiveFs().clearEncodingResolver();
  }

  clearCache(target?: FsTarget): void {
    this.requireActiveFs().clearEncodingCache(target);
  }
}
