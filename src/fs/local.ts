import * as fs from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { FsError, fsErrorFromErrno } from '@deepseek-ai/dsh-fs';
import type {
  FsDeleteOutcome,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
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
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import {
  EncodingStateCache,
  assertLosslessMutationReady,
  compileEncodingOverrides,
  decodeAndValidateNonUtf8WithPreference,
  detectEolStyle,
  encodeTextStrict,
  isProtectedUtf8Bytes,
  isSupportedTextEncoding,
  isValidUtf8Text,
  normalizeEol,
  normalizeLineEndings,
  resolveConfiguredEncoding,
  restoreEol,
} from '../encoding/index.js';
import type {
  CompiledEncodingOverride,
  DecodedText,
  EncodingResolver,
  EolStyle,
  NonUtf8Encoding,
  NonUtf8Preference,
  ResolvedEncodingPreference,
  SupportedTextEncoding,
  Utf8EncodingRecord,
} from '../encoding/index.js';
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
  readonly resolveEncoding?: EncodingResolver;
}

export interface CreateTextOptions {
  readonly encoding: SupportedTextEncoding;
  readonly signal?: AbortSignal;
  readonly sandboxPolicy?: SandboxExecutionPolicy;
}

type TargetEncodingResolution =
  | { readonly kind: 'utf8'; readonly source: 'callback' | 'override' | 'detect' | 'explicit' }
  | { readonly kind: 'non-utf8'; readonly preference: NonUtf8Preference }
  | { readonly kind: 'none' };

/**
 * Encoding-adaptive `LocalFileSystem` subclass.
 *
 * UTF-8 / UTF-8 BOM files delegate strictly through `public` `super.*` methods of
 * `LocalFileSystem`. Explicit rules (`resolveEncoding` callback > `config.encodings`)
 * apply to new files, non-UTF-8 files, and non-protected ASCII files, while
 * protecting existing non-ASCII valid UTF-8 and UTF-8 BOM files.
 */
export class EncodingAdaptiveLocalFileSystem extends LocalFileSystem {
  readonly encodingCache = new EncodingStateCache();
  private overrides: CompiledEncodingOverride[];
  private encodingResolver: EncodingResolver | undefined;
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
    this.encodingResolver = config.resolveEncoding;
    this.overrides = this.compileOverridesWithWarn(config.encodings);
  }

  private readonly warnLog = (message: string): void => {
    this.ctx.logger('fs-encoding-adaptive').warn(message);
  };

  private compileOverridesWithWarn(
    encodings: Record<string, string> | undefined,
  ): CompiledEncodingOverride[] {
    return compileEncodingOverrides(encodings, (pattern, rawEnc) => {
      this.warnLog(
        `Ignoring unsupported encoding '${rawEnc}' for pattern '${pattern}' in config.encodings.`,
      );
    });
  }

  setEncodingOverrides(encodings: Record<string, string> | undefined): void {
    this.overrides = this.compileOverridesWithWarn(encodings);
    this.encodingCache.clear();
  }

  getEncodingOverrides(): readonly CompiledEncodingOverride[] {
    return this.overrides;
  }

  setEncodingResolver(resolver: EncodingResolver): void {
    this.encodingResolver = resolver;
    this.encodingCache.clear();
  }

  clearEncodingResolver(): void {
    this.encodingResolver = undefined;
    this.encodingCache.clear();
  }

  getEncodingResolver(): EncodingResolver | undefined {
    return this.encodingResolver;
  }

  clearEncodingCache(target?: FsTarget): void {
    if (target) {
      this.encodingCache.delete(target.targetKey);
      return;
    }
    this.encodingCache.clear();
  }

  async resolvePreference(
    displayPath: string,
    realPath?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedEncodingPreference | undefined> {
    return await resolveConfiguredEncoding({
      context: {
        filePath: displayPath,
        ...(realPath !== undefined ? { realPath } : {}),
        cwd: this.config.cwd,
        ...(signal !== undefined ? { signal } : {}),
      },
      resolver: this.encodingResolver,
      overrides: this.overrides,
      onWarn: this.warnLog,
    });
  }

  async withEncodingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return await this.targetLocks.withLock(key, fn);
  }

  async withEncodingLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    return await this.targetLocks.withLocks(keys, fn);
  }

  private recordDecoded(
    targetKey: string,
    decoded: DecodedText,
    version: FsVersion,
    eolOverride?: EolStyle,
  ): void {
    this.encodingCache.set(targetKey, {
      encoding: decoded.encoding,
      hasBom: decoded.hasBom,
      eol: eolOverride ?? decoded.eol,
      confident: decoded.confident,
      source: decoded.source,
      version,
    });
  }

  private recordUtf8(
    targetKey: string,
    source: Utf8EncodingRecord['source'],
    version: FsVersion,
  ): void {
    this.encodingCache.set(targetKey, {
      encoding: 'utf8',
      source,
      version,
    });
  }

  private async writeNewNonUtf8(
    target: FsTarget,
    content: string,
    encoding: NonUtf8Encoding,
    source: 'callback' | 'override' | 'explicit',
    createOnly: boolean,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const outBytes = encodeTextStrict(content, encoding, false);
    const newInfo = await writeBytesAtomic(target.targetKey, outBytes, () => this.stat(target), {
      displayPath: target.displayPath,
      ...(createOnly ? { createOnly: true } : {}),
      existingDestination: false,
      ...(signal ? { signal } : {}),
    });

    this.encodingCache.set(target.targetKey, {
      encoding,
      hasBom: false,
      eol: detectEolStyle(content),
      confident: true,
      source,
      version: newInfo.version,
    });

    return {
      operation: 'create',
      version: newInfo.version,
      before: null,
      after: normalizeLineEndings(content),
    };
  }

  private async loadNonUtf8OrProtected(
    target: FsTarget,
    existingVersion: FsVersion,
    initial: { readonly resolution: TargetEncodingResolution; readonly fromCache: boolean },
    expectedVersion?: FsVersion,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'utf8'; readonly source: Utf8EncodingRecord['source'] }
    | {
        readonly kind: 'non-utf8';
        readonly loaded: ReadBytesResult;
        readonly preference: NonUtf8Preference | undefined;
      }
  > {
    const loaded = await readBytesWithStat(
      target.targetKey,
      () => this.stat(target, signal),
      signal,
      target.displayPath,
    );
    if (expectedVersion !== undefined && loaded.info.version !== expectedVersion) {
      throw new FsError(`Stale version for ${target.displayPath}`, 'FS_STALE_VERSION');
    }
    if (isProtectedUtf8Bytes(loaded.raw)) {
      return { kind: 'utf8', source: 'detect' };
    }

    let preference =
      initial.resolution.kind === 'non-utf8' ? initial.resolution.preference : undefined;
    if (initial.fromCache && loaded.info.version !== existingVersion) {
      this.encodingCache.delete(target.targetKey);
      const fresh = await this.resolvePreference(target.displayPath, target.targetKey, signal);
      if (fresh?.encoding === 'utf8' || (!fresh && isValidUtf8Text(loaded.raw))) {
        return { kind: 'utf8', source: fresh ? fresh.source : 'detect' };
      }
      preference = fresh
        ? { encoding: fresh.encoding, source: fresh.source, confident: true }
        : undefined;
    }

    return { kind: 'non-utf8', loaded, preference };
  }

  private async resolveTargetWithCache(
    target: FsTarget,
    version: FsVersion,
    signal?: AbortSignal,
  ): Promise<{ readonly resolution: TargetEncodingResolution; readonly fromCache: boolean }> {
    const cached = this.encodingCache.getIfFresh(target.targetKey, version);
    if (cached) {
      if (cached.encoding === 'utf8') {
        return {
          resolution: { kind: 'utf8', source: cached.source },
          fromCache: true,
        };
      }
      return {
        resolution: {
          kind: 'non-utf8',
          preference: {
            encoding: cached.encoding,
            source: cached.source,
            confident: cached.confident,
          },
        },
        fromCache: true,
      };
    }

    const pref = await this.resolvePreference(target.displayPath, target.targetKey, signal);
    if (!pref) {
      return { resolution: { kind: 'none' }, fromCache: false };
    }
    if (pref.encoding === 'utf8') {
      return {
        resolution: { kind: 'utf8', source: pref.source },
        fromCache: false,
      };
    }
    return {
      resolution: {
        kind: 'non-utf8',
        preference: {
          encoding: pref.encoding,
          source: pref.source,
          confident: true,
        },
      },
      fromCache: false,
    };
  }

  private tryDecodeDiffBasis(
    raw: Buffer,
    displayPath: string,
    preference?: NonUtf8Preference,
  ): string | null {
    if (isValidUtf8Text(raw)) {
      return normalizeLineEndings(raw.toString('utf8'));
    }
    try {
      return decodeAndValidateNonUtf8WithPreference(
        raw,
        displayPath,
        preference,
        [],
        this.config.cwd,
      ).lfText;
    } catch {
      return null;
    }
  }

  private async mutateNonUtf8Bytes(
    target: FsTarget,
    raw: Buffer,
    info: FsInfo,
    mode: number,
    signal: AbortSignal | undefined,
    preference: NonUtf8Preference | undefined,
    transform: (decoded: DecodedText) => string,
  ): Promise<FsEditOutcome> {
    const decoded = decodeAndValidateNonUtf8WithPreference(
      raw,
      target.displayPath,
      preference,
      [],
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

  private async mutateNonUtf8Text(
    target: FsTarget,
    expected: { version: FsVersion } | undefined,
    signal: AbortSignal | undefined,
    preference: NonUtf8Preference | undefined,
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
    return await this.mutateNonUtf8Bytes(target, raw, info, mode, signal, preference, transform);
  }

  private async mutateTextAdaptive(
    target: FsTarget,
    expected: { version: FsVersion } | undefined,
    signal: AbortSignal | undefined,
    superFn: () => Promise<FsEditOutcome>,
    transform: (decoded: DecodedText) => string,
  ): Promise<FsEditOutcome> {
    return await this.withEncodingLock(target.targetKey, async () => {
      if (signal?.aborted) {
        throw new FsError(`Mutation aborted: ${target.displayPath}`, 'FS_ABORTED');
      }

      const existing = await this.stat(target, signal);
      if (
        !existing ||
        existing.type !== 'file' ||
        (expected && existing.version !== expected.version)
      ) {
        return await superFn();
      }

      const initial = await this.resolveTargetWithCache(target, existing.version, signal);
      if (initial.resolution.kind === 'utf8') {
        const outcome = await superFn();
        this.recordUtf8(target.targetKey, initial.resolution.source, outcome.version);
        return outcome;
      }

      if (initial.resolution.kind === 'none') {
        try {
          const outcome = await superFn();
          this.recordUtf8(target.targetKey, 'detect', outcome.version);
          return outcome;
        } catch (err) {
          if (!isFsNotTextError(err)) {
            throw err;
          }
          return await this.mutateNonUtf8Text(target, expected, signal, undefined, transform);
        }
      }

      const classified = await this.loadNonUtf8OrProtected(
        target,
        existing.version,
        initial,
        expected?.version,
        signal,
      );
      if (classified.kind === 'utf8') {
        const outcome = await superFn();
        this.recordUtf8(target.targetKey, classified.source, outcome.version);
        return outcome;
      }

      return await this.mutateNonUtf8Bytes(
        target,
        classified.loaded.raw,
        classified.loaded.info,
        classified.loaded.mode,
        signal,
        classified.preference,
        transform,
      );
    });
  }

  /**
   * Atomically creates a new file using an explicitly requested encoding (`'utf8'`
   * or one of the 16 supported non-UTF-8 encodings). Always uses `createIfAbsent`
   * semantics (`FS_NOT_OBSERVED` when a regular file already exists) and never
   * emits a BOM automatically.
   */
  async createText(
    target: FsTarget,
    content: string,
    options: CreateTextOptions,
  ): Promise<FsWriteOutcome> {
    if (!options || !isSupportedTextEncoding(options.encoding)) {
      throw new FsError(
        `Unsupported encoding '${options.encoding}' for ${target.displayPath}`,
        'FS_IO_ERROR',
      );
    }

    const { encoding, signal } = options;
    return await this.withEncodingLock(target.targetKey, async () => {
      if (signal?.aborted) {
        throw new FsError(`Create aborted: ${target.displayPath}`, 'FS_ABORTED');
      }

      if (encoding === 'utf8') {
        const outcome = await super.writeText(target, content, { kind: 'createIfAbsent' }, signal);
        this.recordUtf8(target.targetKey, 'explicit', outcome.version);
        return outcome;
      }

      const existing = await this.stat(target, signal);
      if (existing) {
        if (existing.type !== 'file') {
          throw new FsError(
            `cannot write "${target.displayPath}": not a regular file`,
            'FS_NOT_REGULAR_FILE',
          );
        }
        throw new FsError(
          `cannot overwrite existing "${target.displayPath}" without reading it first`,
          'FS_NOT_OBSERVED',
        );
      }

      return await this.writeNewNonUtf8(target, content, encoding, 'explicit', true, signal);
    });
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const existing = await this.stat(target, signal);
    if (!existing || existing.type !== 'file') {
      return await super.readText(target, signal);
    }

    const initial = await this.resolveTargetWithCache(target, existing.version, signal);
    if (initial.resolution.kind === 'utf8') {
      const postStat = await this.stat(target, signal);
      const text = await super.readText(target, signal);
      if (postStat) {
        this.recordUtf8(target.targetKey, initial.resolution.source, postStat.version);
      }
      return text;
    }

    if (initial.resolution.kind === 'none') {
      try {
        const postStat = await this.stat(target, signal);
        const text = await super.readText(target, signal);
        if (postStat) {
          this.recordUtf8(target.targetKey, 'detect', postStat.version);
        }
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
        const decoded = decodeAndValidateNonUtf8WithPreference(
          raw,
          target.displayPath,
          undefined,
          [],
          this.config.cwd,
        );
        this.recordDecoded(target.targetKey, decoded, info.version);
        return decoded.text;
      }
    }

    const classified = await this.loadNonUtf8OrProtected(
      target,
      existing.version,
      initial,
      undefined,
      signal,
    );
    if (classified.kind === 'utf8') {
      const postStat = await this.stat(target, signal);
      const text = await super.readText(target, signal);
      if (postStat) {
        this.recordUtf8(target.targetKey, classified.source, postStat.version);
      }
      return text;
    }

    const decoded = decodeAndValidateNonUtf8WithPreference(
      classified.loaded.raw,
      target.displayPath,
      classified.preference,
      [],
      this.config.cwd,
    );
    this.recordDecoded(target.targetKey, decoded, classified.loaded.info.version);
    return decoded.text;
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
        (existing && existing.type !== 'file') ||
        (expected?.kind === 'createIfAbsent' && existing) ||
        (expected?.kind === 'replaceIfVersion' &&
          (!existing || existing.version !== expected.version))
      ) {
        return await super.writeText(target, content, expected, signal);
      }

      if (!existing) {
        const pref = await this.resolvePreference(target.displayPath, target.targetKey, signal);
        if (!pref || pref.encoding === 'utf8') {
          const outcome = await super.writeText(target, content, expected, signal);
          this.recordUtf8(target.targetKey, pref ? pref.source : 'detect', outcome.version);
          return outcome;
        }
        return await this.writeNewNonUtf8(
          target,
          content,
          pref.encoding,
          pref.source,
          expected?.kind === 'createIfAbsent',
          signal,
        );
      }

      const initial = await this.resolveTargetWithCache(target, existing.version, signal);
      if (initial.resolution.kind === 'utf8') {
        const outcome = await super.writeText(target, content, expected, signal);
        this.recordUtf8(target.targetKey, initial.resolution.source, outcome.version);
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

      if (prior === null) {
        const outcome = await super.writeText(target, content, expected, signal);
        this.encodingCache.delete(target.targetKey);
        return outcome;
      }

      if (isProtectedUtf8Bytes(prior.raw)) {
        const outcome = await super.writeText(target, content, expected, signal);
        this.recordUtf8(target.targetKey, 'detect', outcome.version);
        return outcome;
      }

      let effectiveResolution = initial.resolution;
      if (initial.fromCache && prior.info.version !== existing.version) {
        this.encodingCache.delete(target.targetKey);
        const fresh = await this.resolvePreference(target.displayPath, target.targetKey, signal);
        if (fresh?.encoding === 'utf8') {
          const outcome = await super.writeText(target, content, expected, signal);
          this.recordUtf8(target.targetKey, fresh.source, outcome.version);
          return outcome;
        }
        effectiveResolution = fresh
          ? {
              kind: 'non-utf8',
              preference: { encoding: fresh.encoding, source: fresh.source, confident: true },
            }
          : { kind: 'none' };
      }

      if (effectiveResolution.kind === 'none' && isValidUtf8Text(prior.raw)) {
        const outcome = await super.writeText(target, content, expected, signal);
        this.recordUtf8(target.targetKey, 'detect', outcome.version);
        return outcome;
      }

      let decoded: DecodedText;
      try {
        decoded = decodeAndValidateNonUtf8WithPreference(
          prior.raw,
          target.displayPath,
          effectiveResolution.kind === 'non-utf8' ? effectiveResolution.preference : undefined,
          [],
          this.config.cwd,
        );
      } catch (err) {
        if (effectiveResolution.kind === 'none' && isFsNotTextError(err)) {
          // Binary or unsupported prior file with no explicit rule: match official UTF-8 overwrite.
          const outcome = await super.writeText(target, content, expected, signal);
          this.recordUtf8(target.targetKey, 'detect', outcome.version);
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

      this.recordDecoded(target.targetKey, decoded, newInfo.version, targetEol);

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
    return await this.mutateTextAdaptive(
      target,
      expected,
      signal,
      () => super.editText(target, edit, expected, signal),
      (decoded) => applyLiteralEditLf(decoded.lfText, edit, decoded.eol),
    );
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return await this.mutateTextAdaptive(
      target,
      expected,
      signal,
      () => super.patchText(target, hunks, expected, signal),
      (decoded) => {
        const patched = applyHunks(decoded.lfText, hunks);
        if (!patched.ok) {
          throw new FsError(
            `Patch mismatch at hunk line ${patched.failure.hunkLineNumber} (${patched.failure.stage})`,
            'FS_PATCH_MISMATCH',
          );
        }
        return patched.after;
      },
    );
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
          const { resolution } = await this.resolveTargetWithCache(
            target,
            existing.version,
            signal,
          );
          if (resolution.kind !== 'utf8') {
            nonUtf8Before = this.tryDecodeDiffBasis(
              raw,
              target.displayPath,
              resolution.kind === 'non-utf8' ? resolution.preference : undefined,
            );
          }
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

  private async moveNonUtf8File(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<LocalFileSystem['moveFile']>[2],
    signal: AbortSignal | undefined,
    preloaded?: ReadBytesResult,
    sourcePreference?: NonUtf8Preference,
  ): Promise<FsMoveOutcome> {
    const {
      raw: srcRaw,
      info: srcInfo,
      mode: srcMode,
    } = preloaded ??
    (await readBytesWithStat(
      source.targetKey,
      () => this.stat(source, signal),
      signal,
      source.displayPath,
    ));

    if (options.expectedSource && srcInfo.version !== options.expectedSource.version) {
      throw new FsError(`Stale source version for ${source.displayPath}`, 'FS_STALE_VERSION');
    }

    let effectivePreference = sourcePreference;
    if (!effectivePreference) {
      const { resolution } = await this.resolveTargetWithCache(source, srcInfo.version, signal);
      if (resolution.kind === 'utf8') {
        throw new FsError(
          `Configured encoding 'utf8' cannot decode non-UTF-8 file: ${source.displayPath}`,
          'FS_NOT_TEXT',
        );
      }
      effectivePreference = resolution.kind === 'non-utf8' ? resolution.preference : undefined;
    }

    const decoded = decodeAndValidateNonUtf8WithPreference(
      srcRaw,
      source.displayPath,
      effectivePreference,
      [],
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
        if (isValidUtf8Text(prevBytes)) {
          const candidate = normalizeLineEndings(prevBytes.toString('utf8'));
          if (
            Buffer.byteLength(candidate, 'utf8') < this.diffBasisMaxBytes &&
            Buffer.byteLength(afterLf, 'utf8') < this.diffBasisMaxBytes
          ) {
            destBefore = candidate;
          }
        } else {
          const destRes = await this.resolveTargetWithCache(destination, destStat.version, signal);
          if (destRes.resolution.kind !== 'utf8') {
            const candidate = this.tryDecodeDiffBasis(
              prevBytes,
              destination.displayPath,
              destRes.resolution.kind === 'non-utf8' ? destRes.resolution.preference : undefined,
            );
            if (
              candidate !== null &&
              Buffer.byteLength(candidate, 'utf8') < this.diffBasisMaxBytes &&
              Buffer.byteLength(afterLf, 'utf8') < this.diffBasisMaxBytes
            ) {
              destBefore = candidate;
            }
          }
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

    this.encodingCache.delete(destination.targetKey);

    const sourceBefore =
      Buffer.byteLength(decoded.lfText, 'utf8') < this.diffBasisMaxBytes ? decoded.lfText : null;
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

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<LocalFileSystem['moveFile']>[2],
    signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    return await this.withEncodingLocks([source.targetKey, destination.targetKey], async () => {
      if (signal?.aborted) {
        throw new FsError(`Move aborted: ${source.displayPath}`, 'FS_ABORTED');
      }
      if (source.targetKey === destination.targetKey) {
        throw new FsError(
          `Source and destination are the same file: ${source.displayPath}`,
          'FS_SAME_TARGET',
        );
      }

      const hasHunks = Boolean(options.hunks && options.hunks.length > 0);
      if (hasHunks) {
        const srcStat = await this.stat(source, signal);
        if (
          srcStat?.type === 'file' &&
          (!options.expectedSource || srcStat.version === options.expectedSource.version)
        ) {
          const { resolution } = await this.resolveTargetWithCache(source, srcStat.version, signal);
          if (resolution.kind === 'non-utf8') {
            const loaded = await readBytesWithStat(
              source.targetKey,
              () => this.stat(source, signal),
              signal,
              source.displayPath,
            );
            if (!isProtectedUtf8Bytes(loaded.raw)) {
              return await this.moveNonUtf8File(
                source,
                destination,
                options,
                signal,
                loaded,
                resolution.preference,
              );
            }
          }
        }
      }

      try {
        const outcome = await super.moveFile(source, destination, options, signal);
        this.encodingCache.delete(source.targetKey);
        this.encodingCache.delete(destination.targetKey);
        return outcome;
      } catch (err) {
        if (!isFsNotTextError(err)) {
          throw err;
        }
        return await this.moveNonUtf8File(source, destination, options, signal);
      }
    });
  }
}
