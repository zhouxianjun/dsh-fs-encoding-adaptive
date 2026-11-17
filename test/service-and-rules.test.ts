import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { parsePatch } from '@deepseek-ai/dsh-fs-patch';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  applyGrepTool,
} from '@deepseek-ai/dsh-tool-fs-search';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as encodingPlugin from '../src/index.js';
import type { EncodingResolver, FsEncodingService } from '../src/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { readonly version: string };

describe('FsEncodingService, resolver callbacks, unified cache, and proactive ASCII/new-file rules', () => {
  const dirs: string[] = [];
  const ctxs: Context[] = [];

  async function makeTempDir(prefix = 'dsh-fs-enc-svc-', baseDir = os.tmpdir()): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(baseDir, prefix));
    dirs.push(dir);
    return dir;
  }

  function registerFakeSandboxPolicy(ctx: Context, mode: SandboxMode, workspaceRoot: string) {
    class MockSandboxPolicy extends Service {
      readonly defaultMode = mode;
      constructor(c: Context) {
        super(c, 'sandboxPolicy');
      }
      resolve(req?: { mode?: SandboxMode }): SandboxExecutionPolicy {
        return {
          mode: req?.mode ?? mode,
          workspaceRoot,
        };
      }
    }
    return ctx.plugin(MockSandboxPolicy);
  }

  function attachWarnSpy(ctx: Context) {
    const warnSpy = vi.fn();
    const origLogger = ctx.logger.bind(ctx);
    (ctx as unknown as { logger: typeof ctx.logger }).logger = ((loggerName: string) => {
      const l = origLogger(loggerName);
      l.warn = warnSpy as never;
      return l;
    }) as typeof ctx.logger;
    return warnSpy;
  }

  afterEach(async () => {
    await Promise.all(ctxs.splice(0).map((c) => c.fiber.dispose()));
    await Promise.all(
      dirs.splice(0).map((d) => fs.promises.rm(d, { recursive: true, force: true })),
    );
  });

  it('mounts ctx.fsEncoding with package version, creates new files atomically without BOM, and enforces sandboxPolicy on both utf8 and non-utf8', async () => {
    const workspace = await makeTempDir('dsh-enc-svc-ws-');
    const outside = await makeTempDir('dsh-enc-svc-out-', '/var/tmp');

    const ctx = new Context();
    ctxs.push(ctx);
    const sandboxFork = registerFakeSandboxPolicy(ctx, 'workspace-write', workspace);
    await ctx
      .plugin(encodingPlugin, {
        cwd: workspace,
        sandbox: true,
        encodings: { '*.txt': 'gbk' },
      })
      .await();

    const fsSvc = (ctx as Context & { fs: FileSystem }).fs;
    const encSvc = (ctx as Context & { fsEncoding: FsEncodingService }).fsEncoding;

    expect(encSvc).toBeDefined();
    expect(encSvc.version).toBe(pkg.version);

    // 1. Explicit createText('gbk') writes BOM-less GBK and caches for subsequent editText
    const gbkPath = path.join(workspace, 'created.gbk.txt');
    const gbkTarget = await fsSvc.resolve(gbkPath);
    const gbkOutcome = await encSvc.createText(gbkTarget, '纯ASCII初始行\r\n第二行\r\n', {
      encoding: 'gbk',
    });
    expect(gbkOutcome.operation).toBe('create');
    expect(gbkOutcome.before).toBeNull();
    expect(gbkOutcome.after).toBe('纯ASCII初始行\n第二行\n');
    expect(
      (await fs.promises.readFile(gbkPath)).equals(
        iconv.encode('纯ASCII初始行\r\n第二行\r\n', 'gbk'),
      ),
    ).toBe(true);

    // Existing regular file rejected with FS_NOT_OBSERVED without overwriting bytes
    await expect(
      encSvc.createText(gbkTarget, 'should not overwrite', { encoding: 'utf8' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' });
    await expect(
      encSvc.createText(gbkTarget, 'should not overwrite', { encoding: 'gbk' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' });
    expect(
      (await fs.promises.readFile(gbkPath)).equals(
        iconv.encode('纯ASCII初始行\r\n第二行\r\n', 'gbk'),
      ),
    ).toBe(true);

    // Existing directory rejected with FS_NOT_REGULAR_FILE
    const dirPath = path.join(workspace, 'subdir');
    await fs.promises.mkdir(dirPath);
    await expect(
      encSvc.createText(await fsSvc.resolve(dirPath), 'x', { encoding: 'gbk' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' });

    // Unmappable characters rejected strictly without creating partial file
    const badEmojiPath = path.join(workspace, 'bad-emoji.gbk.txt');
    await expect(
      encSvc.createText(await fsSvc.resolve(badEmojiPath), 'hello 😀', { encoding: 'gbk' }),
    ).rejects.toMatchObject({ code: 'FS_IO_ERROR' });
    expect(fs.existsSync(badEmojiPath)).toBe(false);

    // Invalid runtime encoding rejected
    await expect(
      encSvc.createText(await fsSvc.resolve(path.join(workspace, 'invalid.txt')), 'abc', {
        encoding: 'gb2312' as unknown as 'gbk',
      }),
    ).rejects.toMatchObject({ code: 'FS_IO_ERROR' });

    // 2. Explicit createText('utf8') overrides *.txt -> gbk config rule
    const utf8Path = path.join(workspace, 'explicit-utf8.txt');
    const utf8Target = await fsSvc.resolve(utf8Path);
    await encSvc.createText(utf8Target, 'ascii-only-first-line\n', { encoding: 'utf8' });
    expect(
      (await fs.promises.readFile(utf8Path)).equals(Buffer.from('ascii-only-first-line\n', 'utf8')),
    ).toBe(true);
    // Same version reuses cached explicit 'utf8' when editing Chinese
    await fsSvc.editText(utf8Target, {
      oldString: 'ascii-only-first-line',
      newString: '显式UTF8中文内容',
      replaceAll: false,
    });
    expect(await fs.promises.readFile(utf8Path, 'utf8')).toBe('显式UTF8中文内容\n');

    // 3. Sandbox confinement enforced on both 'utf8' and 'gbk' paths
    const outsideUtf8 = await fsSvc.resolve(path.join(outside, 'blocked-utf8.txt'));
    const outsideGbk = await fsSvc.resolve(path.join(outside, 'blocked-gbk.txt'));
    await expect(encSvc.createText(outsideUtf8, 'x', { encoding: 'utf8' })).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    });
    await expect(encSvc.createText(outsideGbk, 'x', { encoding: 'gbk' })).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    });

    // Per-call sandboxPolicy escalation allows writing outside
    await encSvc.createText(outsideGbk, '放行中文', {
      encoding: 'gbk',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    });
    expect(
      (await fs.promises.readFile(path.join(outside, 'blocked-gbk.txt'))).equals(
        iconv.encode('放行中文', 'gbk'),
      ),
    ).toBe(true);

    // 4. Disposing sandboxPolicy unmounts ctx.fsEncoding and clears activeFs cleanly
    await sandboxFork.dispose();
    expect((ctx as Context & { fsEncoding?: FsEncodingService }).fsEncoding).toBeUndefined();
    await expect(
      encSvc.createText(await fsSvc.resolve(path.join(workspace, 'after-dispose.txt')), 'x', {
        encoding: 'gbk',
      }),
    ).rejects.toMatchObject({ code: 'FS_IO_ERROR' });
  });

  it('enforces callback > config.encodings > auto-detection, fallback on ordinary errors, abort propagation, and unified cache invalidation', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);
    const warnSpy = attachWarnSpy(ctx);

    const resolverSpy = vi.fn<EncodingResolver>(async ({ filePath }) => {
      if (filePath.endsWith('cb-gbk.txt')) {
        return 'gbk';
      }
      if (filePath.endsWith('cb-utf8.txt')) {
        return 'utf8';
      }
      if (filePath.endsWith('cb-invalid.txt')) {
        return 'unknown-codec' as unknown as 'gbk';
      }
      if (filePath.endsWith('cb-throw.txt')) {
        throw new Error('transient adapter error');
      }
      if (filePath.endsWith('cb-abort.txt')) {
        const abortErr = new Error('aborted by caller');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return undefined;
    });

    await ctx
      .plugin(encodingPlugin, {
        cwd: dir,
        sandbox: false,
        encodings: {
          '*.txt': 'shift_jis',
          'bad.bin': 'not-a-codec',
          'exempt.txt': 'utf8',
        },
        resolveEncoding: resolverSpy,
      })
      .await();

    const fsSvc = (ctx as Context & { fs: FileSystem }).fs;
    const encSvc = (ctx as Context & { fsEncoding: FsEncodingService }).fsEncoding;

    // Invalid config.encodings entry logged warning and skipped
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-a-codec'));

    // 1. Callback 'gbk' overrides '*.txt': 'shift_jis' on new pure-ASCII/Chinese file, and caches across read/edit/write
    const cbGbkPath = path.join(dir, 'cb-gbk.txt');
    const cbGbkTarget = await fsSvc.resolve(cbGbkPath);
    await fsSvc.writeText(cbGbkTarget, 'ascii-seed\n');
    expect(resolverSpy).toHaveBeenCalledTimes(1);

    // Same version: readText, editText, writeText reuse unified cache without re-invoking callback
    expect(await fsSvc.readText(cbGbkTarget)).toBe('ascii-seed\n');
    expect(resolverSpy).toHaveBeenCalledTimes(1);

    await fsSvc.editText(cbGbkTarget, {
      oldString: 'ascii-seed',
      newString: '回调覆盖GBK中文',
      replaceAll: false,
    });
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(
      (await fs.promises.readFile(cbGbkPath)).equals(iconv.encode('回调覆盖GBK中文\n', 'gbk')),
    ).toBe(true);

    // External version change invalidates cache -> callback runs again
    await fs.promises.writeFile(cbGbkPath, iconv.encode('外部修改版本\n', 'gbk'));
    // Ensure mtime/version changes across fast filesystems by appending or touching
    const bumped = iconv.encode('外部修改版本_extra\n', 'gbk');
    await fs.promises.writeFile(cbGbkPath, bumped);
    expect(await fsSvc.readText(cbGbkTarget)).toBe('外部修改版本_extra\n');
    expect(resolverSpy).toHaveBeenCalledTimes(2);

    // Explicit clearCache invalidates cache for that target
    encSvc.clearCache(cbGbkTarget);
    expect(await fsSvc.readText(cbGbkTarget)).toBe('外部修改版本_extra\n');
    expect(resolverSpy).toHaveBeenCalledTimes(3);

    // 2. Callback returning 'utf8' overrides '*.txt': 'shift_jis' and caches 'utf8' across ops
    const cbUtf8Path = path.join(dir, 'cb-utf8.txt');
    const cbUtf8Target = await fsSvc.resolve(cbUtf8Path);
    const callsBeforeUtf8 = resolverSpy.mock.calls.length;
    await fsSvc.writeText(cbUtf8Target, 'UTF8回调优先中文\n');
    expect(await fsSvc.readText(cbUtf8Target)).toBe('UTF8回调优先中文\n');
    await fsSvc.editText(cbUtf8Target, {
      oldString: '优先',
      newString: '缓存命中',
      replaceAll: false,
    });
    expect(resolverSpy).toHaveBeenCalledTimes(callsBeforeUtf8 + 1);
    expect(await fs.promises.readFile(cbUtf8Path, 'utf8')).toBe('UTF8回调缓存命中中文\n');

    // 3. Callback invalid return or ordinary error falls back to config.encodings ('shift_jis') with warn
    const invPath = path.join(dir, 'cb-invalid.txt');
    const invTarget = await fsSvc.resolve(invPath);
    await fsSvc.writeText(invTarget, '日本語フォールバック\n');
    expect(
      (await fs.promises.readFile(invPath)).equals(
        iconv.encode('日本語フォールバック\n', 'shift_jis'),
      ),
    ).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-codec'));

    const throwPath = path.join(dir, 'cb-throw.txt');
    const throwTarget = await fsSvc.resolve(throwPath);
    await fsSvc.writeText(throwTarget, '例外フォールバック\n');
    expect(
      (await fs.promises.readFile(throwPath)).equals(
        iconv.encode('例外フォールバック\n', 'shift_jis'),
      ),
    ).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('transient adapter error'));

    // 4. Later-wins UTF-8 exemption in config.encodings when callback returns undefined
    const exemptPath = path.join(dir, 'exempt.txt');
    await fsSvc.writeText(await fsSvc.resolve(exemptPath), '豁免为UTF8中文\n');
    expect(await fs.promises.readFile(exemptPath, 'utf8')).toBe('豁免为UTF8中文\n');

    // 5. Callback abort propagates FS_ABORTED rather than falling back
    const abortPath = path.join(dir, 'cb-abort.txt');
    await expect(fsSvc.writeText(await fsSvc.resolve(abortPath), 'never')).rejects.toMatchObject({
      code: 'FS_ABORTED',
    });

    // 6. Dynamic setEncodingResolver / clearEncodingResolver invalidates cache
    encSvc.setEncodingResolver(() => 'gbk');
    expect(await fs.promises.readFile(exemptPath, 'utf8')).toBe('豁免为UTF8中文\n');
    // Protected non-ASCII UTF-8 file stays UTF-8 even under dynamic 'gbk' callback!
    await fsSvc.editText(await fsSvc.resolve(exemptPath), {
      oldString: '豁免',
      newString: '受保护',
      replaceAll: false,
    });
    expect(await fs.promises.readFile(exemptPath, 'utf8')).toBe('受保护为UTF8中文\n');

    // New/ASCII file picks up dynamic 'gbk' callback, then clearEncodingResolver restores 'shift_jis'
    const dynPath = path.join(dir, 'dynamic.txt');
    await fsSvc.writeText(await fsSvc.resolve(dynPath), '动态GBK\n');
    expect((await fs.promises.readFile(dynPath)).equals(iconv.encode('动态GBK\n', 'gbk'))).toBe(
      true,
    );

    encSvc.clearEncodingResolver();
    const afterClearPath = path.join(dir, 'after-clear.txt');
    await fsSvc.writeText(await fsSvc.resolve(afterClearPath), 'デフォルト\n');
    expect(
      (await fs.promises.readFile(afterClearPath)).equals(
        iconv.encode('デフォルト\n', 'shift_jis'),
      ),
    ).toBe(true);
  });

  it('protects existing UTF-8 & UTF-8 BOM files, handles pure ASCII rules without ASCII-to-UTF16 magic, emits accurate notices, and keeps ordinary moveFile byte-exact', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);
    ctx.plugin(ToolsService, {});
    ctx.plugin(nativeExecutor);
    ctx.plugin(SystemPrompt, {});
    await ctx
      .plugin(encodingPlugin, {
        cwd: dir,
        sandbox: false,
        encodings: {
          '*.txt': 'gbk',
          '*.u16': 'utf16le',
          'dest/*.gbk': 'gbk',
        },
      })
      .await();

    const fsSvc = (ctx as Context & { fs: FileSystem }).fs;
    const tools = (ctx as Context & { tools: ToolsService }).tools;

    // 1. Existing non-ASCII UTF-8 and UTF-8 BOM files under '*.txt': 'gbk' stay UTF-8
    const utf8Path = path.join(dir, 'existing-utf8.txt');
    const bomPath = path.join(dir, 'existing-bom.txt');
    await fs.promises.writeFile(utf8Path, Buffer.from('原有 UTF-8 中文内容\n', 'utf8'));
    await fs.promises.writeFile(
      bomPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('ASCII-ONLY-WITH-BOM\n', 'utf8'),
      ]),
    );

    const utf8Target = await fsSvc.resolve(utf8Path);
    const bomTarget = await fsSvc.resolve(bomPath);
    await fsSvc.editText(utf8Target, {
      oldString: '原有',
      newString: '保留',
      replaceAll: false,
    });
    expect(await fs.promises.readFile(utf8Path, 'utf8')).toBe('保留 UTF-8 中文内容\n');

    await fsSvc.editText(bomTarget, {
      oldString: 'ASCII-ONLY-WITH-BOM',
      newString: 'BOM后写入中文仍为UTF8',
      replaceAll: false,
    });
    // Native LocalFileSystem strips UTF-8 BOM on edit and writes UTF-8 (protected from *.txt -> gbk)
    expect(await fs.promises.readFile(bomPath, 'utf8')).toBe('BOM后写入中文仍为UTF8\n');

    // 2. Pure ASCII file under '*.txt': 'gbk' -> read caches & emits rule notice, edit/patch write GBK
    const asciiPath = path.join(dir, 'pure-ascii.txt');
    await fs.promises.writeFile(asciiPath, Buffer.from('line1=ascii\nline2=ascii\n', 'ascii'));

    tools.register({
      name: 'read',
      description: 'Read text',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: unknown) {
        const { file_path } = args as { file_path: string };
        return await fsSvc.readText(await fsSvc.resolve(file_path));
      },
    });

    const ac = new AbortController();
    const readRes = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'r1' as ToolCallId,
          name: 'read',
          arguments: JSON.stringify({ file_path: asciiPath }),
        },
      ],
      signal: ac.signal,
    });
    const contexts = readRes.results[0]!.result.additionalContexts ?? readRes.additionalContexts;
    expect(contexts).toHaveLength(1);
    const notice = (contexts[0]!.content[0] as { type: 'text'; text: string }).text;
    expect(notice).toContain('handled as gbk via rule');
    expect(notice).toContain('source: override');
    expect(notice).not.toContain('was decoded from');

    const asciiTarget = await fsSvc.resolve(asciiPath);
    await fsSvc.editText(asciiTarget, {
      oldString: 'line1=ascii',
      newString: 'line1=第一行中文',
      replaceAll: false,
    });
    const patch = parsePatch(
      '*** Begin Patch\n*** Update File: pure-ascii.txt\n@@\n line1=第一行中文\n-line2=ascii\n+line2=第二行中文\n*** End Patch',
    );
    if (patch[0]?.kind !== 'update') {
      throw new Error('expected update hunk');
    }
    await fsSvc.patchText(asciiTarget, patch[0].hunks);
    expect(
      (await fs.promises.readFile(asciiPath)).equals(
        iconv.encode('line1=第一行中文\nline2=第二行中文\n', 'gbk'),
      ),
    ).toBe(true);

    // 3. Odd-byte pure ASCII file under '*.u16': 'utf16le' fails as FS_NOT_TEXT (no ASCII->UTF16 conversion)
    const oddAsciiPath = path.join(dir, 'odd.u16');
    await fs.promises.writeFile(oddAsciiPath, Buffer.from('hello', 'ascii'));
    await expect(fsSvc.readText(await fsSvc.resolve(oddAsciiPath))).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
    });

    // 4. Ordinary moveFile preserves source bytes and does not auto-transcode to destination rule
    await fs.promises.mkdir(path.join(dir, 'dest'), { recursive: true });
    const moveSrc = path.join(dir, 'plain.csv');
    const moveDst = path.join(dir, 'dest', 'moved.gbk');
    await fs.promises.writeFile(moveSrc, Buffer.from('plain ascii content\n', 'utf8'));
    await fsSvc.moveFile(await fsSvc.resolve(moveSrc), await fsSvc.resolve(moveDst), {});
    expect(
      (await fs.promises.readFile(moveDst)).equals(Buffer.from('plain ascii content\n', 'utf8')),
    ).toBe(true);
  });

  it('keeps grep independent of encodingCache/callbacks/config, refreshes stale cache on external edits, and clears destination cache on moveFile', async () => {
    const workspace = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);

    class MockWorkingDirectory extends Service {
      constructor(c: Context) {
        super(c, 'workingDirectory');
      }
      async ensure(): Promise<string> {
        return workspace;
      }
    }

    const resolverSpy = vi.fn<EncodingResolver>(() => 'gbk');

    ctx.plugin(MockWorkingDirectory);
    ctx.plugin(ToolsService, {});
    ctx.plugin(nativeExecutor);
    ctx.plugin(SystemPrompt, {});
    ctx.plugin(LocalSubprocessRuntime);
    await ctx
      .plugin(encodingPlugin, {
        sandbox: false,
        cwd: workspace,
        encodings: {
          'src/*.gbk': 'gbk',
          'dst/*.txt': 'utf8',
        },
        resolveEncoding: resolverSpy,
      })
      .await();

    applyGrepTool(ctx, {
      maxMatches: GREP_MAX_MATCHES,
      maxLineBytes: GREP_MAX_LINE_BYTES,
      maxMetaBytes: SEARCH_META_MAX_BYTES,
      rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
      graceMs: SEARCH_GRACE_MS,
      stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });

    const tools = (ctx as Context & { tools: ToolsService }).tools;
    const fsSvc = (ctx as Context & { fs: FileSystem }).fs;
    const encSvc = (ctx as Context & { fsEncoding: FsEncodingService }).fsEncoding;

    // 1. Large >64 KiB file starting with valid UTF-8 bytes then GBK bytes:
    // grep must NOT cache 'utf8' into encodingCache or invoke resolveEncoding.
    const trickyPath = path.join(workspace, 'tricky-chunk1.gbk.txt');
    const trickyBytes = Buffer.concat([
      Buffer.from([0xc3, 0xa9]),
      Buffer.from('A'.repeat(70 * 1024), 'ascii'),
      iconv.encode('\n后面是GBK中文段落\n', 'gbk'),
    ]);
    await fs.promises.writeFile(trickyPath, trickyBytes);

    const agent = { session: { header: { id: 'svc-grep-independent' } } } as never;
    const ac = new AbortController();
    const grepRes = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'g1' as ToolCallId,
          name: 'grep',
          arguments: JSON.stringify({ pattern: 'AAAA' }),
        },
      ],
      signal: ac.signal,
      agent,
    });
    expect(grepRes.results[0]!.result.isError).toBe(false);
    expect(resolverSpy).not.toHaveBeenCalled();

    // Subsequent readText & editText on trickyPath still succeed as GBK without stale 'utf8' cache poisoning
    const trickyTarget = await fsSvc.resolve(trickyPath);
    expect(await fsSvc.readText(trickyTarget)).toContain('后面是GBK中文段落');
    expect(resolverSpy).toHaveBeenCalledTimes(1);

    // 2. moveFile clears destination cache instead of copying source rule provenance
    encSvc.clearEncodingResolver();
    await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.promises.mkdir(path.join(workspace, 'dst'), { recursive: true });
    const srcGbk = path.join(workspace, 'src', 'a.gbk');
    const dstTxt = path.join(workspace, 'dst', 'b.txt');
    await fs.promises.writeFile(srcGbk, iconv.encode('纯ASCII前缀\n旧行\n', 'gbk'));
    await fsSvc.moveFile(await fsSvc.resolve(srcGbk), await fsSvc.resolve(dstTxt), {
      hunks: [
        {
          lineNumber: 1,
          oldLines: ['旧行'],
          newLines: ['新行'],
          isEndOfFile: true,
        },
      ],
    });
    // Destination matches 'dst/*.txt': 'utf8', so readText rejects GBK bytes rather than hitting copied 'gbk' override cache
    await expect(fsSvc.readText(await fsSvc.resolve(dstTxt))).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
    });

    // 3. External version change between stat and readBytesWithStat invalidates stale cache in writeText & editText
    const extPath = path.join(workspace, 'ext-race.txt');
    await fs.promises.writeFile(
      extPath,
      iconv.encode('这是一段用于测试外部并发版本的GBK文本内容。\nline1\n', 'gbk'),
    );
    const extTarget = await fsSvc.resolve(extPath);
    expect(await fsSvc.readText(extTarget)).toContain('line1');

    const origStat = fsSvc.stat.bind(fsSvc);
    let statCount = 0;
    const statSpy = vi.spyOn(fsSvc, 'stat').mockImplementation(async (t, s) => {
      if (t.targetKey === extTarget.targetKey) {
        statCount++;
        if (statCount === 2) {
          await fs.promises.writeFile(extPath, '外部已改为UTF8中文内容\n', 'utf8');
        }
      }
      return await origStat(t, s);
    });
    await fsSvc.writeText(extTarget, '再次写入应保护UTF8中文\n');
    statSpy.mockRestore();
    expect(await fs.promises.readFile(extPath, 'utf8')).toBe('再次写入应保护UTF8中文\n');

    // Also verify editText refreshes stale cache when file is externally replaced by another legacy encoding
    const extEditPath = path.join(workspace, 'ext-edit.txt');
    await fs.promises.writeFile(
      extEditPath,
      iconv.encode('初始GBK文本内容用于缓存验证。\nkeep\n', 'gbk'),
    );
    const extEditTarget = await fsSvc.resolve(extEditPath);
    expect(await fsSvc.readText(extEditTarget)).toContain('keep');

    let editStatCount = 0;
    const editStatSpy = vi.spyOn(fsSvc, 'stat').mockImplementation(async (t, s) => {
      if (t.targetKey === extEditTarget.targetKey) {
        editStatCount++;
        if (editStatCount === 2) {
          await fs.promises.writeFile(
            extEditPath,
            iconv.encode('外部変更された日本語テキスト。\nkeep\n', 'shift_jis'),
          );
        }
      }
      return await origStat(t, s);
    });
    await fsSvc.editText(extEditTarget, {
      oldString: 'keep',
      newString: 'updated',
      replaceAll: false,
    });
    editStatSpy.mockRestore();
    expect(
      (await fs.promises.readFile(extEditPath)).equals(
        iconv.encode('外部変更された日本語テキスト。\nupdated\n', 'shift_jis'),
      ),
    ).toBe(true);
  });
});
