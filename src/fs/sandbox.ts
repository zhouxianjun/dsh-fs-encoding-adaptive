import type { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import type {
  FsDeleteOutcome,
  FsEditOutcome,
  FsEditRequest,
  FsMoveOutcome,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs';
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import { checkedTarget } from '../upstream/sandbox-fence.js';
import { EncodingAdaptiveLocalFileSystem } from './local.js';
import type { EncodingAdaptiveConfig } from './local.js';

interface SandboxPolicyServiceLike {
  readonly defaultMode: SandboxMode;
  resolve(request?: unknown): SandboxExecutionPolicy;
}

/**
 * Sandbox-enforcing subclass of `EncodingAdaptiveLocalFileSystem`.
 *
 * Mirrors `@deepseek-ai/dsh-fs-sandbox` via `checkedTarget` on all five mutating
 * operations while inheriting UTF-8 passthrough and non-UTF-8 encoding handling
 * directly from `EncodingAdaptiveLocalFileSystem`.
 */
export class EncodingAdaptiveSandboxedFileSystem extends EncodingAdaptiveLocalFileSystem {
  static readonly inject: string[] = ['sandboxPolicy'];
  private readonly defaultMode: SandboxMode;

  constructor(ctx: Context, config: EncodingAdaptiveConfig = {}) {
    super(ctx, config);
    const policy = (this.ctx as Context & { sandboxPolicy?: SandboxPolicyServiceLike })
      .sandboxPolicy;
    if (!policy) {
      throw new FsError(
        'sandboxPolicy service is required when sandbox enforcement is enabled',
        'FS_SANDBOX_DENIED',
      );
    }
    this.defaultMode = policy.defaultMode;
  }

  override get sandboxMode(): SandboxMode {
    return this.defaultMode;
  }

  private resolveDefaultPolicy(): SandboxExecutionPolicy {
    const policy = (this.ctx as Context & { sandboxPolicy: SandboxPolicyServiceLike })
      .sandboxPolicy;
    return policy.resolve();
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const fresh = await checkedTarget(
      this,
      target,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    return await super.writeText(fresh, content, expected, signal);
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const fresh = await checkedTarget(
      this,
      target,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    return await super.editText(fresh, edit, expected, signal);
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const fresh = await checkedTarget(
      this,
      target,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    return await super.patchText(fresh, hunks, expected, signal);
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    const fresh = await checkedTarget(
      this,
      target,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    return await super.deleteFile(fresh, expected, signal);
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<EncodingAdaptiveLocalFileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    const freshSource = await checkedTarget(
      this,
      source,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    const freshDest = await checkedTarget(
      this,
      destination,
      () => this.resolveDefaultPolicy(),
      sandboxPolicy,
    );
    return await super.moveFile(freshSource, freshDest, options, signal);
  }
}
