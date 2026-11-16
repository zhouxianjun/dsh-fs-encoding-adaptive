import * as fs from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { FsError, fsErrorFromErrno } from '@deepseek-ai/dsh-fs';
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
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local';
import { applyHunks } from '@deepseek-ai/dsh-fs-patch';
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch';
import {
  EncodingStateCache,
  assertLosslessMutationReady,
  compileEncodingOverrides,
  decodeAndValidateNonUtf8,
  encodeTextStrict,
  isValidUtf8Text,
  normalizeEol,
  normalizeLineEndings,
  restoreEol,
} from '../encoding/index.js';
import type { CompiledEncodingOverride, DecodedText } from '../encoding/index.js';
import {
  readBoundedBytesIfSmall,
  readBytesWithStat,
  writeBytesAtomic,
} from '../upstream/atomic-write.js';
import type { ReadBytesResult } from '../upstream/atomic-write.js';
import { applyLiteralEditLf, detectContentEolOrLf, isFsNotTextError } from './edit.js';
import { TargetLockManager } from './locks.js';

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;

export interface EncodingAdaptiveConfig extends LocalConfig {
  readonly encodings?: Record<string, string>;
}

/**
 * Encoding-adaptive `LocalFileSystem` subclass.
 *
 * UTF-8 / UTF-8 BOM / ASCII reads, writes, edits, patches, moves, deletes,
 * stats, listings, watches, and all `streamText` calls delegate strictly through
 * `public` `super.*` methods of `LocalFileSystem`. Non-UTF-8 files preserve
 * their detected encoding, BOM, and EOL semantics atomically while sourcing
 * official `FsVersion` tokens from `this.stat(...)`.
 */
export class EncodingAdaptiveLocalFileSystem extends LocalFileSystem {
  readonly encodingCache = new EncodingStateCache();
  private overrides: CompiledEncodingOverride[];
  private readonly diffBasisMaxBytes: number;
  private readonly targetLocks = new TargetLockManager();

  constructor(ctx: Context, config: EncodingAdaptiveConfig = {}) {
    const diffBasisMaxBytes = config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES;
    const localConfig: LocalConfig = {
      cwd: config.cwd ?? process.cwd(),
      diffBasisMaxBytes,
    };
    super(ctx, localConfig);
    this.diffBasisMaxBytes = diffBasisMaxBytes;
    this.overrides = compileEncodingOverrides(config.encodings);
  }

  setEncodingOverrides(encodings: Record<string, string> | undefined): void {
    this.overrides = compileEncodingOverrides(encodings);
    this.encodingCache.clear();
  }

  getEncodingOverrides(): readonly CompiledEncodingOverride[] {
    return this.overrides;
  }

  async withEncodingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return await this.targetLocks.withLock(key, fn);
  }

  async withEncodingLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    return await this.targetLocks.withLocks(keys, fn);
  }

  private recordDecoded(targetKey: string, decoded: DecodedText, version: FsVersion): void {
    this.encodingCache.set(targetKey, {
      encoding: decoded.encoding,
      hasBom: decoded.hasBom,
      eol: decoded.eol,
      confident: decoded.confident,
      source: decoded.source,
      version,
    });
  }

  private tryDecodeDiffBasis(raw: Buffer, displayPath: string): string | null {
    if (isValidUtf8Text(raw)) {
      return normalizeLineEndings(raw.toString('utf8'));
    }
    try {
      return decodeAndValidateNonUtf8(raw, displayPath, this.overrides, this.config.cwd).lfText;
    } catch {
      return null;
    }
  }

  private async mutateNonUtf8Text(
    target: FsTarget,
    expected: { version: FsVersion } | undefined,
    signal: AbortSignal | undefined,
    transform: (decoded: DecodedText) => string,
  ): Promise<FsEditOutcome> {
    const { raw, info, mode } = await readBytesWithStat(
      target.targetKey,
      () => this.stat(target, signal),
      signal,
      target.displayPath,
    );
    if (expected && info.version !== expected.version) {
      throw new FsError(`Stale version for ${target.displayPath}`, 'FS_STALE_VERSION');
    }

    const decoded = decodeAndValidateNonUtf8(
      raw,
      target.displayPath,
      this.overrides,
      this.config.cwd,
    );
    assertLosslessMutationReady(raw, decoded, target.displayPath);

    const afterLf = transform(decoded);
    const outBytes = encodeTextStrict(
      restoreEol(afterLf, decoded.eol),
      decoded.encoding,
      decoded.hasBom,
    );

    const newInfo = await writeBytesAtomic(target.targetKey, outBytes, () => this.stat(target), {
      displayPath: target.displayPath,
      existingDestination: true,
      expectedVersion: info.version,
      mode,
      ...(signal ? { signal } : {}),
    });

    this.recordDecoded(target.targetKey, decoded, newInfo.version);

    return {
      version: newInfo.version,
      before: decoded.lfText,
      after: afterLf,
    };
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const text = await super.readText(target, signal);
      this.encodingCache.delete(target.targetKey);
      return text;
    } catch (err) {
      if (!isFsNotTextError(err)) {
        throw err;
      }
      const { raw, info } = await readBytesWithStat(
        target.targetKey,
        () => this.stat(target, signal),
        signal,
        target.displayPath,
      );
      const decoded = decodeAndValidateNonUtf8(
        raw,
        target.displayPath,
        this.overrides,
        this.config.cwd,
      );
      this.recordDecoded(target.targetKey, decoded, info.version);
      return decoded.text;
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return await this.withEncodingLock(target.targetKey, async () => {
      if (signal?.aborted) {
        throw new FsError(`Write aborted: ${target.displayPath}`, 'FS_ABORTED');
      }

      const existing = await this.stat(target, signal);
      if (
        !existing ||
        existing.type !== 'file' ||
        expected?.kind === 'createIfAbsent' ||
        (expected?.kind === 'replaceIfVersion' && existing.version !== expected.version)
      ) {
        const outcome = await super.writeText(target, content, expected, signal);
        this.encodingCache.delete(target.targetKey);
        return outcome;
      }

      let prior: ReadBytesResult | null = null;
      try {
        prior = await readBytesWithStat(
          target.targetKey,
          () => this.stat(target, signal),
          signal,
          target.displayPath,
        );
      } catch (err) {
        if (
          err instanceof FsError &&
          (err.code === 'FS_ABORTED' ||
            err.code === 'FS_STALE_VERSION' ||
            err.code === 'FS_NOT_REGULAR_FILE')
        ) {
          throw err;
        }
        if (err instanceof FsError) {
          prior = null;
        } else {
          throw err;
        }
      }

      if (
        prior !== null &&
        expected?.kind === 'replaceIfVersion' &&
        prior.info.version !== expected.version
      ) {
        throw new FsError(
          `cannot write "${target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        );
      }

      if (prior === null || isValidUtf8Text(prior.raw)) {
        const outcome = await super.writeText(target, content, expected, signal);
        this.encodingCache.delete(target.targetKey);
        return outcome;
      }

      let decoded: DecodedText;
      try {
        decoded = decodeAndValidateNonUtf8(
          prior.raw,
          target.displayPath,
          this.overrides,
          this.config.cwd,
        );
      } catch (err) {
        if (isFsNotTextError(err)) {
          // Binary or unsupported prior file: match official behavior by overwriting as UTF-8.
          const outcome = await super.writeText(target, content, expected, signal);
          this.encodingCache.delete(target.targetKey);
          return outcome;
        }
        throw err;
      }

      if (!decoded.confident) {
        throw new FsError(
          `Low-confidence encoding detection ('${decoded.encoding}') for ${target.displayPath}; configure encodings override before writing`,
          'FS_NOT_TEXT',
        );
      }

      const targetEol = decoded.eol === 'mixed' ? detectContentEolOrLf(content) : decoded.eol;
      const normalizedInput =
        decoded.eol === 'cr' ? normalizeEol(content) : normalizeLineEndings(content);
      const outBytes = encodeTextStrict(
        restoreEol(normalizedInput, targetEol),
        decoded.encoding,
        decoded.hasBom,
      );

      const newInfo = await writeBytesAtomic(target.targetKey, outBytes, () => this.stat(target), {
        displayPath: target.displayPath,
        existingDestination: true,
        expectedVersion: prior.info.version,
        mode: prior.mode,
        ...(signal ? { signal } : {}),
      });

      this.encodingCache.set(target.targetKey, {
        encoding: decoded.encoding,
        hasBom: decoded.hasBom,
        eol: targetEol,
        confident: decoded.confident,
        source: decoded.source,
        version: newInfo.version,
      });

      const afterNormalized = normalizeLineEndings(content);
      const includeBefore =
        Buffer.byteLength(decoded.lfText, 'utf8') < this.diffBasisMaxBytes &&
        Buffer.byteLength(afterNormalized, 'utf8') < this.diffBasisMaxBytes;

      return {
        operation: 'update',
        version: newInfo.version,
        before: includeBefore ? decoded.lfText : null,
        after: afterNormalized,
      };
    });
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return await this.withEncodingLock(target.targetKey, async () => {
      try {
        const outcome = await super.editText(target, edit, expected, signal);
        this.encodingCache.delete(target.targetKey);
        return outcome;
      } catch (err) {
        if (!isFsNotTextError(err)) {
          throw err;
        }
        return await this.mutateNonUtf8Text(target, expected, signal, (decoded) =>
          applyLiteralEditLf(decoded.lfText, edit, decoded.eol),
        );
      }
    });
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return await this.withEncodingLock(target.targetKey, async () => {
      try {
        const outcome = await super.patchText(target, hunks, expected, signal);
        this.encodingCache.delete(target.targetKey);
        return outcome;
      } catch (err) {
        if (!isFsNotTextError(err)) {
          throw err;
        }
        return await this.mutateNonUtf8Text(target, expected, signal, (decoded) => {
          const patched = applyHunks(decoded.lfText, hunks);
          if (!patched.ok) {
            throw new FsError(
              `Patch mismatch at hunk line ${patched.failure.hunkLineNumber} (${patched.failure.stage})`,
              'FS_PATCH_MISMATCH',
            );
          }
          return patched.after;
        });
      }
    });
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsDeleteOutcome> {
    return await this.withEncodingLock(target.targetKey, async () => {
      let nonUtf8Before: string | null = null;
      const existing = await this.stat(target, signal);
      if (
        existing?.type === 'file' &&
        existing.size !== undefined &&
        existing.size < this.diffBasisMaxBytes &&
        (!expected || existing.version === expected.version)
      ) {
        const raw = await readBoundedBytesIfSmall(target.targetKey, this.diffBasisMaxBytes, signal);
        if (raw !== null && !isValidUtf8Text(raw)) {
          nonUtf8Before = this.tryDecodeDiffBasis(raw, target.displayPath);
        }
      }

      const outcome = await super.deleteFile(target, expected, signal);
      this.encodingCache.delete(target.targetKey);
      if (outcome.before === null && nonUtf8Before !== null) {
        return { before: nonUtf8Before };
      }
      return outcome;
    });
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<LocalFileSystem['moveFile']>[2],
    signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    return await this.withEncodingLocks([source.targetKey, destination.targetKey], async () => {
      try {
        const outcome = await super.moveFile(source, destination, options, signal);
        this.encodingCache.delete(source.targetKey);
        this.encodingCache.delete(destination.targetKey);
        return outcome;
      } catch (err) {
        if (!isFsNotTextError(err)) {
          throw err;
        }

        if (source.targetKey === destination.targetKey) {
          throw new FsError(
            `Source and destination are the same file: ${source.displayPath}`,
            'FS_SAME_TARGET',
          );
        }

        const {
          raw: srcRaw,
          info: srcInfo,
          mode: srcMode,
        } = await readBytesWithStat(
          source.targetKey,
          () => this.stat(source, signal),
          signal,
          source.displayPath,
        );

        if (options.expectedSource && srcInfo.version !== options.expectedSource.version) {
          throw new FsError(`Stale source version for ${source.displayPath}`, 'FS_STALE_VERSION');
        }

        const decoded = decodeAndValidateNonUtf8(
          srcRaw,
          source.displayPath,
          this.overrides,
          this.config.cwd,
        );
        let afterLf = decoded.lfText;
        let outBytes = srcRaw;

        if (options.hunks && options.hunks.length > 0) {
          assertLosslessMutationReady(srcRaw, decoded, source.displayPath);
          const patched = applyHunks(decoded.lfText, options.hunks);
          if (!patched.ok) {
            throw new FsError(
              `Patch mismatch at hunk line ${patched.failure.hunkLineNumber} (${patched.failure.stage})`,
              'FS_PATCH_MISMATCH',
            );
          }
          afterLf = patched.after;
          outBytes = encodeTextStrict(
            restoreEol(afterLf, decoded.eol),
            decoded.encoding,
            decoded.hasBom,
          );
        }

        const destStat = await this.stat(destination, signal);
        if (destStat && destStat.type !== 'file') {
          throw new FsError(
            `Destination is not a regular file: ${destination.displayPath}`,
            'FS_NOT_REGULAR_FILE',
          );
        }
        if (options.expectedDestination?.kind === 'createIfAbsent' && destStat !== undefined) {
          throw new FsError(
            `Destination already exists: ${destination.displayPath}`,
            'FS_NOT_OBSERVED',
          );
        }
        if (options.expectedDestination?.kind === 'replaceIfVersion') {
          if (!destStat || destStat.version !== options.expectedDestination.version) {
            throw new FsError(
              `Stale destination version for ${destination.displayPath}`,
              'FS_STALE_VERSION',
            );
          }
        }

        let destBefore: string | null = null;
        if (
          destStat?.type === 'file' &&
          destStat.size !== undefined &&
          destStat.size < this.diffBasisMaxBytes
        ) {
          const prevBytes = await readBoundedBytesIfSmall(
            destination.targetKey,
            this.diffBasisMaxBytes,
            signal,
          );
          if (prevBytes !== null) {
            const candidate = this.tryDecodeDiffBasis(prevBytes, destination.displayPath);
            if (
              candidate !== null &&
              Buffer.byteLength(candidate, 'utf8') < this.diffBasisMaxBytes &&
              Buffer.byteLength(afterLf, 'utf8') < this.diffBasisMaxBytes
            ) {
              destBefore = candidate;
            }
          }
        }

        await this.internals.inspectBeforeMutation?.(source);
        if (signal?.aborted) {
          throw new FsError(`Move aborted: ${source.displayPath}`, 'FS_ABORTED');
        }
        // After this checkpoint, complete destination publication, source removal,
        // and outcome reporting even if cancellation arrives.

        const destInfo = await writeBytesAtomic(
          destination.targetKey,
          outBytes,
          () => this.stat(destination),
          {
            displayPath: destination.displayPath,
            existingDestination: destStat !== undefined,
            ...(options.expectedDestination?.kind === 'createIfAbsent' ? { createOnly: true } : {}),
            ...(options.expectedDestination?.kind === 'replaceIfVersion'
              ? { expectedVersion: options.expectedDestination.version }
              : {}),
            mode: srcMode,
          },
        );

        this.recordDecoded(destination.targetKey, decoded, destInfo.version);

        const sourceBefore =
          Buffer.byteLength(decoded.lfText, 'utf8') < this.diffBasisMaxBytes
            ? decoded.lfText
            : null;
        const includeDestBasis =
          destStat === undefined ||
          (Buffer.byteLength(afterLf, 'utf8') < this.diffBasisMaxBytes &&
            (destBefore !== null || destStat.type !== 'file'));

        const destinationOutcome: FsWriteOutcome = {
          operation: destStat ? 'update' : 'create',
          version: destInfo.version,
          before: includeDestBasis ? destBefore : null,
          after: afterLf,
        };

        try {
          await (this.internals.removeFile ?? fs.promises.unlink)(source.targetKey);
          this.encodingCache.delete(source.targetKey);
          return {
            sourceBefore,
            destination: destinationOutcome,
            sourceDeleted: true,
          };
        } catch (unlinkErr) {
          const mapped = fsErrorFromErrno('unlink', source.displayPath, unlinkErr);
          if (!(mapped instanceof FsError)) {
            throw mapped;
          }
          return {
            sourceBefore,
            destination: destinationOutcome,
            sourceDeleted: false,
            sourceFailure: {
              code: mapped.code,
              message: `Published ${destination.displayPath} but failed to remove ${source.displayPath}: ${
                unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
              }`,
            },
          };
        }
      }
    });
  }
}
