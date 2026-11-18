import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { FsVersion } from '@deepseek-ai/dsh-fs';
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { parsePatch } from '@deepseek-ai/dsh-fs-patch';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { TextBlock } from '@deepseek-ai/dsh-llm';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncodingAdaptiveLocalFileSystem } from '../src/fs/local.js';
import { readBytesWithStat, writeBytesAtomic } from '../src/upstream/atomic-write.js';
import * as encodingPlugin from '../src/index.js';

async function collectStream(iterable: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iterable) {
    out += chunk;
  }
  return out;
}

describe('EncodingAdaptiveLocalFileSystem', () => {
  const dirs: string[] = [];
  const ctxs: Context[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-fs-enc-fs-'));
    dirs.push(dir);
    return dir;
  }

  function makeAdaptive(dir: string, overrides?: Record<string, string>) {
    const ctx = new Context();
    ctxs.push(ctx);
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctx, {
      cwd: dir,
      diffBasisMaxBytes: 10 * 1024 * 1024,
      ...(overrides ? { encodings: overrides } : {}),
    });
    return { ctx, adaptive };
  }

  afterEach(async () => {
    await Promise.all(ctxs.splice(0).map((c) => c.fiber.dispose()));
    await Promise.all(
      dirs.splice(0).map((d) => fs.promises.rm(d, { recursive: true, force: true })),
    );
  });

  it('GBK file after editText remains GBK on disk and mutates ONLY the target byte region (LF & CRLF)', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    for (const [name, eol] of [
      ['sample-lf.txt', '\n'],
      ['sample-crlf.txt', '\r\n'],
    ] as const) {
      const prefix = `// 头部注释：禁止改动这里的中文与符号（测试）。${eol}const a = "第一行甲乙丙";${eol}`;
      const oldMid = `const target = "旧的目标字段中文";`;
      const newMid = `const target = "新的替换结果字";`;
      const suffix = `${eol}const b = "尾部保留段落丁戊己";${eol}// 结尾注释${eol}`;

      const originalText = prefix + oldMid + suffix;
      const originalBytes = iconv.encode(originalText, 'gbk');
      const prefixBytes = iconv.encode(prefix, 'gbk');
      const suffixBytes = iconv.encode(suffix, 'gbk');
      const newMidBytes = iconv.encode(newMid, 'gbk');

      const filePath = path.join(dir, name);
      await fs.promises.writeFile(filePath, originalBytes);

      const target = await adaptive.resolve(filePath);
      expect(await adaptive.readText(target)).toBe(originalText);

      const outcome = await adaptive.editText(target, {
        oldString: oldMid,
        newString: newMid,
        replaceAll: false,
      });

      expect(outcome.before).toBe(originalText.replace(/\r\n/g, '\n'));
      expect(outcome.after).toBe((prefix + newMid + suffix).replace(/\r\n/g, '\n'));

      const afterBytes = await fs.promises.readFile(filePath);
      expect(afterBytes.subarray(0, prefixBytes.length).equals(prefixBytes)).toBe(true);
      expect(
        afterBytes
          .subarray(prefixBytes.length, prefixBytes.length + newMidBytes.length)
          .equals(newMidBytes),
      ).toBe(true);
      expect(afterBytes.subarray(afterBytes.length - suffixBytes.length).equals(suffixBytes)).toBe(
        true,
      );
      expect(afterBytes.length).toBe(prefixBytes.length + newMidBytes.length + suffixBytes.length);
    }
  });

  it('UTF-8 BOM file behaves 100% identically to unmodified official LocalFileSystem', async () => {
    const dir = await makeTempDir();
    const ctxOff = new Context();
    const ctxAdp = new Context();
    ctxs.push(ctxOff, ctxAdp);

    const official = new LocalFileSystem(ctxOff, {
      cwd: dir,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    });
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctxAdp, { cwd: dir });

    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const initialBody = '第一行：UTF-8 BOM 内容\r\n第二行：待修改\r\n第三行：末尾\r\n';
    const initialBytes = Buffer.concat([bom, Buffer.from(initialBody, 'utf8')]);

    const offFile = path.join(dir, 'official-bom.txt');
    const adpFile = path.join(dir, 'adaptive-bom.txt');
    await fs.promises.writeFile(offFile, initialBytes);
    await fs.promises.writeFile(adpFile, initialBytes);

    const offTarget = await official.resolve(offFile);
    const adpTarget = await adaptive.resolve(adpFile);

    expect(await adaptive.readText(adpTarget)).toBe(await official.readText(offTarget));
    expect(await collectStream(await adaptive.streamText(adpTarget))).toBe(
      await collectStream(await official.streamText(offTarget)),
    );

    const offEdit = await official.editText(offTarget, {
      oldString: '第二行：待修改',
      newString: '第二行：已修改完成',
      replaceAll: false,
    });
    const adpEdit = await adaptive.editText(adpTarget, {
      oldString: '第二行：待修改',
      newString: '第二行：已修改完成',
      replaceAll: false,
    });
    expect(adpEdit.before).toBe(offEdit.before);
    expect(adpEdit.after).toBe(offEdit.after);
    expect((await fs.promises.readFile(adpFile)).equals(await fs.promises.readFile(offFile))).toBe(
      true,
    );

    const hunk = {
      lineNumber: 1,
      oldLines: ['第三行：末尾'],
      newLines: ['第三行：补丁更新'],
      isEndOfFile: true,
    };
    const offPatch = await official.patchText(offTarget, [hunk]);
    const adpPatch = await adaptive.patchText(adpTarget, [hunk]);
    expect(adpPatch.before).toBe(offPatch.before);
    expect(adpPatch.after).toBe(offPatch.after);
    expect((await fs.promises.readFile(adpFile)).equals(await fs.promises.readFile(offFile))).toBe(
      true,
    );

    await fs.promises.writeFile(offFile, initialBytes);
    await fs.promises.writeFile(adpFile, initialBytes);
    const offWrite = await official.writeText(offTarget, '全新内容\n第二行');
    const adpWrite = await adaptive.writeText(adpTarget, '全新内容\n第二行');
    expect(adpWrite.operation).toBe(offWrite.operation);
    expect(adpWrite.before).toBe(offWrite.before);
    expect(adpWrite.after).toBe(offWrite.after);
    expect((await fs.promises.readFile(adpFile)).equals(await fs.promises.readFile(offFile))).toBe(
      true,
    );

    await fs.promises.writeFile(offFile, initialBytes);
    await fs.promises.writeFile(adpFile, initialBytes);
    const offDest = await official.resolve(path.join(dir, 'official-moved.txt'));
    const adpDest = await adaptive.resolve(path.join(dir, 'adaptive-moved.txt'));
    const offMove = await official.moveFile(offTarget, offDest, {});
    const adpMove = await adaptive.moveFile(adpTarget, adpDest, {});
    expect(adpMove.sourceBefore).toBe(offMove.sourceBefore);
    expect(adpMove.destination.before).toBe(offMove.destination.before);
    expect(adpMove.destination.after).toBe(offMove.destination.after);
    expect(adpMove.sourceDeleted).toBe(offMove.sourceDeleted);
    expect(
      (await fs.promises.readFile(path.join(dir, 'adaptive-moved.txt'))).equals(
        await fs.promises.readFile(path.join(dir, 'official-moved.txt')),
      ),
    ).toBe(true);
  });

  it('inherits official streamText directly while readText decodes >64KB ASCII+GBK', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    expect(adaptive.streamText).toBe(LocalFileSystem.prototype.streamText);

    const asciiPrefix = 'ASCII-HEADER-LINE\r\n'.repeat(4000); // > 72 KB
    const gbkBody = '中文正文：在超过64KB纯ASCII头部之后出现的GBK字符。\r\n结束行。\r\n';
    const filePath = path.join(dir, 'large-gbk.txt');
    await fs.promises.writeFile(filePath, iconv.encode(asciiPrefix + gbkBody, 'gbk'));

    const adpTarget = await adaptive.resolve(filePath);
    expect(await adaptive.readText(adpTarget)).toBe(asciiPrefix + gbkBody);
  });

  it('supports writeText, patchText, deleteFile, and moveFile across GBK, Shift-JIS, and UTF-16LE BOM', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    // 1. writeText preserves existing GBK & CRLF; creates new file as UTF-8
    const gbkPath = path.join(dir, 'config.gbk.txt');
    await fs.promises.writeFile(
      gbkPath,
      iconv.encode('这是一份中文配置文件，使用 GBK 编码保存。\r\nkey=value\r\n', 'gbk'),
    );
    const gbkTarget = await adaptive.resolve(gbkPath);
    const info1 = await adaptive.stat(gbkTarget);
    const writeOutcome = await adaptive.writeText(gbkTarget, '新的中文配置内容\n第二行配置\n', {
      kind: 'replaceIfVersion',
      version: info1!.version,
    });
    expect(writeOutcome.operation).toBe('update');
    expect(writeOutcome.before).toBe('这是一份中文配置文件，使用 GBK 编码保存。\nkey=value\n');
    expect(writeOutcome.after).toBe('新的中文配置内容\n第二行配置\n');
    const rewrittenBytes = await fs.promises.readFile(gbkPath);
    expect(rewrittenBytes.equals(iconv.encode('新的中文配置内容\r\n第二行配置\r\n', 'gbk'))).toBe(
      true,
    );

    // Unmappable character when overwriting GBK must fail without mutating the file.
    await expect(adaptive.writeText(gbkTarget, '不能保存的表情 🚀\n')).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
    });
    expect((await fs.promises.readFile(gbkPath)).equals(rewrittenBytes)).toBe(true);

    // Binary prior file overwritten by writeText falls back to official UTF-8 write with before: null
    const binPath = path.join(dir, 'blob.bin');
    await fs.promises.writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    const binTarget = await adaptive.resolve(binPath);
    const binWrite = await adaptive.writeText(binTarget, 'now plain utf8');
    expect(binWrite.before).toBeNull();
    expect(await fs.promises.readFile(binPath, 'utf8')).toBe('now plain utf8');

    // 2. patchText on UTF-16LE BOM file
    const u16Path = path.join(dir, 'notes-u16.txt');
    const u16Orig = 'Alpha\r\n中文行：旧内容\r\nOmega\r\n';
    await fs.promises.writeFile(
      u16Path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(u16Orig, 'utf16-le')]),
    );
    const u16Target = await adaptive.resolve(u16Path);
    const patchHunks = parsePatch(
      '*** Begin Patch\n*** Update File: notes-u16.txt\n@@\n Alpha\n-中文行：旧内容\n+中文行：补丁新内容\n Omega\n*** End Patch',
    );
    const op = patchHunks[0]!;
    if (op.kind !== 'update') {
      throw new Error('expected update');
    }
    const patchRes = await adaptive.patchText(u16Target, op.hunks);
    expect(patchRes.after).toBe('Alpha\n中文行：补丁新内容\nOmega\n');
    const u16Disk = await fs.promises.readFile(u16Path);
    expect(u16Disk[0]).toBe(0xff);
    expect(u16Disk[1]).toBe(0xfe);
    expect(iconv.decode(u16Disk.subarray(2), 'utf16-le')).toBe(
      'Alpha\r\n中文行：补丁新内容\r\nOmega\r\n',
    );

    // 3. moveFile on Shift-JIS file with hunks, then deleteFile
    const sjisSrcPath = path.join(dir, 'src-sjis.txt');
    const sjisDstPath = path.join(dir, 'dst-sjis.txt');
    const sjisOrig = '一括処理：日本語テストの原文です。\n二行目：変更前\n三行目：終了\n';
    await fs.promises.writeFile(sjisSrcPath, iconv.encode(sjisOrig, 'shift_jis'));
    const sjisSrc = await adaptive.resolve(sjisSrcPath);
    const sjisDst = await adaptive.resolve(sjisDstPath);
    const movePatch = parsePatch(
      '*** Begin Patch\n*** Update File: src-sjis.txt\n@@\n 一括処理：日本語テストの原文です。\n-二行目：変更前\n+二行目：移動後\n 三行目：終了\n*** End Patch',
    );
    const moveOp = movePatch[0]!;
    if (moveOp.kind !== 'update') {
      throw new Error('expected update');
    }

    const moveOutcome = await adaptive.moveFile(sjisSrc, sjisDst, {
      hunks: moveOp.hunks,
      expectedDestination: { kind: 'createIfAbsent' },
    });
    expect(moveOutcome.sourceDeleted).toBe(true);
    expect(fs.existsSync(sjisSrcPath)).toBe(false);
    expect(
      (await fs.promises.readFile(sjisDstPath)).equals(
        iconv.encode(
          '一括処理：日本語テストの原文です。\n二行目：移動後\n三行目：終了\n',
          'shift_jis',
        ),
      ),
    ).toBe(true);

    await adaptive.deleteFile(sjisDst);
    expect(fs.existsSync(sjisDstPath)).toBe(false);
    expect(adaptive.encodingCache.getLatest(sjisDst.targetKey)).toBeUndefined();
  });

  it('enforces stat1->read->stat2 race detection, pre-rename version check, dead-PID tmpdir cleanup, and reentrant locking', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    const filePath = path.join(dir, 'race.gbk.txt');
    await fs.promises.writeFile(
      filePath,
      iconv.encode('这是一段用于并发与原子写入校验的GBK文本内容。\n第二行原始文本\n', 'gbk'),
    );
    const target = await adaptive.resolve(filePath);
    const v1 = (await adaptive.stat(target))!.version;

    // stat1 -> readFile -> stat2 detects concurrent mid-read version changes
    let readStatCalls = 0;
    await expect(
      readBytesWithStat(target.targetKey, async () => {
        readStatCalls++;
        const real = await adaptive.stat(target);
        if (readStatCalls > 1 && real) {
          return { ...real, version: FsVersion('mid-read-changed-version') };
        }
        return real;
      }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });

    // Dead-PID leftover staging directory cleanup
    const deadTmpDir = path.join(dir, '.dsh-enc-tmp-999999-stale');
    await fs.promises.mkdir(deadTmpDir);
    await fs.promises.writeFile(path.join(deadTmpDir, 'leftover'), 'x');

    // Pre-rename stale version rejection inside writeBytesAtomic
    const staleStatFn = async (): Promise<FsInfo | undefined> => {
      const real = await adaptive.stat(target);
      return real ? { ...real, version: FsVersion('stale-changed-version') } : real;
    };

    await expect(
      writeBytesAtomic(target.targetKey, iconv.encode('不会落盘的文本\n', 'gbk'), staleStatFn, {
        expectedVersion: v1,
      }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });
    expect(fs.existsSync(deadTmpDir)).toBe(false);

    // Reentrant lock via AsyncLocalStorage does not deadlock, and concurrent guarded edits serialize
    let innerExecuted = false;
    await adaptive.withEncodingLock(target.targetKey, async () => {
      await adaptive.withEncodingLock(target.targetKey, async () => {
        innerExecuted = true;
      });
    });
    expect(innerExecuted).toBe(true);

    const p1 = adaptive.editText(
      target,
      { oldString: '第二行原始文本', newString: '第一次并发编辑', replaceAll: false },
      { version: v1 },
    );
    const p2 = adaptive.editText(
      target,
      { oldString: '第二行原始文本', newString: '第二次并发编辑', replaceAll: false },
      { version: v1 },
    );
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'FS_STALE_VERSION',
    });
  });

  it('attaches encoding hint in additionalContexts on read tools/post-execute without altering tool content', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);

    class MockSandboxPolicy extends Service {
      readonly defaultMode = 'workspace-write';
      constructor(c: Context) {
        super(c, 'sandboxPolicy');
      }
      resolve() {
        return { mode: 'workspace-write' as const, workspaceRoot: dir };
      }
    }

    ctx.plugin(MockSandboxPolicy);
    ctx.plugin(SystemPrompt, {});
    ctx.plugin(ToolsService, {});
    ctx.plugin(nativeExecutor);
    await ctx.plugin(encodingPlugin, { sandbox: false, cwd: dir }).await();

    const fsSvc = ctx.fs;
    const tools = ctx.tools;

    const gbkFile = path.join(dir, 'legacy.gbk.txt');
    const utf8BomFile = path.join(dir, 'native-bom.txt');
    const gbkText = '这是一段足够长以便自动探测为 GBK 编码的中文说明文档。\n第二行正文。\n';
    await fs.promises.writeFile(gbkFile, iconv.encode(gbkText, 'gbk'));
    await fs.promises.writeFile(
      utf8BomFile,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('UTF-8 BOM 文本\n', 'utf8')]),
    );

    tools.register({
      name: 'read',
      description: 'Read a text file',
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
        const t: FsTarget = await fsSvc.resolve(file_path);
        const content = await fsSvc.readText(t);
        return `<path>${file_path}</path>\n<type>file</type>\n<content>\n${content}\n</content>`;
      },
    });

    const controller = new AbortController();
    const batchGbk = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('c1'),
          name: 'read',
          arguments: JSON.stringify({ file_path: gbkFile }),
        },
      ],
      signal: controller.signal,
    });
    const resGbk = batchGbk.results[0]!.result;
    expect(resGbk.isError).toBe(false);
    expect(resGbk.content[0]).toEqual({
      type: 'text',
      text: `<path>${gbkFile}</path>\n<type>file</type>\n<content>\n${gbkText}\n</content>`,
    });
    const gbkContexts = resGbk.additionalContexts ?? batchGbk.additionalContexts;
    expect(gbkContexts).toHaveLength(1);
    const noticeText = (gbkContexts[0]!.content[0] as TextBlock).text;
    expect(noticeText).toContain('gbk');
    expect(noticeText).toContain('LF');

    const batchBom = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('c2'),
          name: 'read',
          arguments: JSON.stringify({ file_path: utf8BomFile }),
        },
      ],
      signal: controller.signal,
    });
    const resBom = batchBom.results[0]!.result;
    expect(resBom.isError).toBe(false);
    expect(resBom.additionalContexts).toBeUndefined();
    expect(batchBom.additionalContexts).toHaveLength(0);

    // Also attach notice on str_replace_editor view command (and skip non-view commands)
    tools.register({
      name: 'str_replace_editor',
      description: 'Editor view/replace',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['command', 'path'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: unknown) {
        const { command, path: p } = args as { command: string; path: string };
        const t: FsTarget = await fsSvc.resolve(p);
        if (command === 'view') {
          return await fsSvc.readText(t);
        }
        return 'ok';
      },
    });

    const batchView = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('c3'),
          name: 'str_replace_editor',
          arguments: JSON.stringify({ command: 'view', path: gbkFile }),
        },
      ],
      signal: controller.signal,
    });
    const resView = batchView.results[0]!.result;
    expect(resView.isError).toBe(false);
    const viewContexts = resView.additionalContexts ?? batchView.additionalContexts;
    expect(viewContexts).toHaveLength(1);
    expect((viewContexts[0]!.content[0] as TextBlock).text).toContain('gbk');

    const batchStrReplace = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('c4'),
          name: 'str_replace_editor',
          arguments: JSON.stringify({ command: 'str_replace', path: gbkFile }),
        },
      ],
      signal: controller.signal,
    });
    expect(batchStrReplace.results[0]!.result.additionalContexts).toBeUndefined();
    expect(batchStrReplace.additionalContexts).toHaveLength(0);

    const lowConfMixedNotice = encodingPlugin.formatEncodingNotice('mixed.csv', {
      encoding: 'utf16le',
      hasBom: true,
      eol: 'mixed',
      confident: false,
      source: 'chardet',
      version: FsVersion('v1'),
    });
    expect(lowConfMixedNotice).toContain('utf16le');
    expect(lowConfMixedNotice).toContain('BOM');
    expect(lowConfMixedNotice).toContain('MIXED');
    expect(lowConfMixedNotice).toContain('encodings');
  });

  it('provides cwd default and validates positive diffBasisMaxBytes', async () => {
    const cfgDefault = encodingPlugin.Config({});
    expect(cfgDefault.cwd).toBe(process.cwd());
    expect(() => encodingPlugin.Config({ diffBasisMaxBytes: 0 })).toThrow();

    const ctx = new Context();
    ctxs.push(ctx);
    const fsNoCwd = new EncodingAdaptiveLocalFileSystem(ctx, {});
    // Relative resolve without opts.cwd must not throw isAbsolute(undefined)
    const relNoOpts = await fsNoCwd.resolve('relative.txt');
    expect(relNoOpts.targetKey).toBe(path.join(process.cwd(), 'relative.txt'));
  });

  it('aligns writeText error handling (directory, aborted, 0o200, replaceIfVersion missing) and separates encoding preservation from diffBasisMaxBytes', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctx, {
      cwd: dir,
      diffBasisMaxBytes: 64,
    });

    // Directory target -> FS_NOT_REGULAR_FILE
    const subDir = path.join(dir, 'subdir');
    await fs.promises.mkdir(subDir);
    const dirTarget = await adaptive.resolve(subDir);
    await expect(adaptive.writeText(dirTarget, 'hello')).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
    });

    // Aborted signal -> FS_ABORTED
    const ac = new AbortController();
    ac.abort();
    const abortTarget = await adaptive.resolve(path.join(dir, 'aborted.txt'));
    await expect(
      adaptive.writeText(abortTarget, 'hello', undefined, ac.signal),
    ).rejects.toMatchObject({
      code: 'FS_ABORTED',
    });

    // replaceIfVersion on a deleted/missing target returns FS_STALE_VERSION like official
    const deletedGbkPath = path.join(dir, 'deleted.gbk.txt');
    await fs.promises.writeFile(
      deletedGbkPath,
      iconv.encode('这是一段即将被删除的 GBK 中文文件。\n', 'gbk'),
    );
    const deletedTarget = await adaptive.resolve(deletedGbkPath);
    const observed = await adaptive.stat(deletedTarget);
    await fs.promises.unlink(deletedGbkPath);
    await expect(
      adaptive.writeText(deletedTarget, 'rewrite\n', {
        kind: 'replaceIfVersion',
        version: observed!.version,
      }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });

    // Small diffBasisMaxBytes (64) only drops `before` diff basis; non-UTF-8 encoding & CRLF are STILL preserved!
    const bigGbk = iconv.encode('中文测试内容'.repeat(20) + '\r\n', 'gbk');
    expect(bigGbk.length).toBeGreaterThanOrEqual(64);
    const bigPath = path.join(dir, 'over-diff-limit.gbk.txt');
    await fs.promises.writeFile(bigPath, bigGbk);
    const bigTarget = await adaptive.resolve(bigPath);
    const bigOut = await adaptive.writeText(bigTarget, '新的覆盖中文\n第二行\n');
    expect(bigOut.operation).toBe('update');
    expect(bigOut.before).toBeNull();
    expect(bigOut.after).toBe('新的覆盖中文\n第二行\n');
    expect(
      (await fs.promises.readFile(bigPath)).equals(
        iconv.encode('新的覆盖中文\r\n第二行\r\n', 'gbk'),
      ),
    ).toBe(true);

    // Low-confidence non-UTF-8 overwrite is still rejected
    const lowConfPath = path.join(dir, 'low-conf.txt');
    await fs.promises.writeFile(lowConfPath, iconv.encode('你好', 'gbk'));
    const lowConfTarget = await adaptive.resolve(lowConfPath);
    await expect(adaptive.writeText(lowConfTarget, '覆盖内容')).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
    });

    // Write-only 0o200 file succeeds via official fallback with before: null (non-root)
    if (process.getuid?.() !== 0) {
      const roPath = path.join(dir, 'write-only.gbk.txt');
      await fs.promises.writeFile(roPath, iconv.encode('旧内容\n', 'gbk'), { mode: 0o200 });
      const roTarget = await adaptive.resolve(roPath);
      const roInfo = await adaptive.stat(roTarget);
      const roOut = await adaptive.writeText(roTarget, 'overwritten\n', {
        kind: 'replaceIfVersion',
        version: roInfo!.version,
      });
      expect(roOut.before).toBeNull();
      expect(roOut.after).toBe('overwritten\n');
      await fs.promises.chmod(roPath, 0o600);
      expect(await fs.promises.readFile(roPath, 'utf8')).toBe('overwritten\n');
    }

    // Strict `< diffBasisMaxBytes`: exact === 64 UTF-8 bytes yields before: null, while preserving GBK
    const exact64Path = path.join(dir, 'exact64.gbk.txt');
    // 20 Chinese chars in GBK = 40 bytes (<64 on disk), in UTF-8 = 60 bytes; add 4 ASCII bytes = 64 UTF-8 bytes
    const exact64Text = '中文内容'.repeat(5) + 'abcd';
    expect(Buffer.byteLength(exact64Text, 'utf8')).toBe(64);
    await fs.promises.writeFile(exact64Path, iconv.encode(exact64Text, 'gbk'));
    const exactTarget = await adaptive.resolve(exact64Path);
    const exactOut = await adaptive.writeText(exactTarget, '中文短句\n');
    expect(exactOut.before).toBeNull();
    expect(
      (await fs.promises.readFile(exact64Path)).equals(iconv.encode('中文短句\n', 'gbk')),
    ).toBe(true);
  });

  it('preserves GBK encoding when overwriting a >10 MiB GBK file with default diffBasisMaxBytes and returns before: null', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    const gbkLine = iconv.encode(
      '这是一段用于测试超过10MiB大文件覆盖写仍保留GBK编码的测试行。\r\n',
      'gbk',
    );
    const targetBytes = 10 * 1024 * 1024 + 64 * 1024;
    const repeats = Math.ceil(targetBytes / gbkLine.length);
    const largeGbk = Buffer.concat(Array.from({ length: repeats }, () => gbkLine));
    expect(largeGbk.length).toBeGreaterThan(10 * 1024 * 1024);

    const largePath = path.join(dir, 'over-10mib.gbk.txt');
    await fs.promises.writeFile(largePath, largeGbk);
    const target = await adaptive.resolve(largePath);

    const newText = '覆盖后的大文件新内容\n第二行\n';
    const outcome = await adaptive.writeText(target, newText);
    expect(outcome.operation).toBe('update');
    expect(outcome.before).toBeNull();
    expect(outcome.after).toBe(newText);
    expect(
      (await fs.promises.readFile(largePath)).equals(
        iconv.encode('覆盖后的大文件新内容\r\n第二行\r\n', 'gbk'),
      ),
    ).toBe(true);
  });

  it('matches official LocalFileSystem on new files, plain UTF-8, and pure ASCII writeText and streamText', async () => {
    const dir = await makeTempDir();
    const ctxOff = new Context();
    const ctxAdp = new Context();
    ctxs.push(ctxOff, ctxAdp);
    const official = new LocalFileSystem(ctxOff, {
      cwd: dir,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    });
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctxAdp, { cwd: dir });

    // 1. New file create (createIfAbsent + collision)
    const newOff = await official.resolve(path.join(dir, 'new-off.txt'));
    const newAdp = await adaptive.resolve(path.join(dir, 'new-adp.txt'));
    const createOff = await official.writeText(newOff, 'hello UTF-8 中文\n', {
      kind: 'createIfAbsent',
    });
    const createAdp = await adaptive.writeText(newAdp, 'hello UTF-8 中文\n', {
      kind: 'createIfAbsent',
    });
    expect(createAdp.operation).toBe(createOff.operation);
    expect(createAdp.before).toBe(createOff.before);
    expect(createAdp.after).toBe(createOff.after);
    expect(
      (await fs.promises.readFile(newAdp.targetKey)).equals(
        await fs.promises.readFile(newOff.targetKey),
      ),
    ).toBe(true);
    await expect(
      adaptive.writeText(newAdp, 'dup', { kind: 'createIfAbsent' }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' });

    // 2. Plain UTF-8 and pure ASCII overwrites
    for (const [label, initialBytes, replacement] of [
      ['utf8', Buffer.from('旧 UTF-8 内容\r\n', 'utf8'), '新 UTF-8 内容\n'],
      ['ascii', Buffer.from('plain ascii\r\n', 'ascii'), 'updated ascii\n'],
    ] as const) {
      const pOff = path.join(dir, `${label}-off.txt`);
      const pAdp = path.join(dir, `${label}-adp.txt`);
      await fs.promises.writeFile(pOff, initialBytes);
      await fs.promises.writeFile(pAdp, initialBytes);
      const tOff = await official.resolve(pOff);
      const tAdp = await adaptive.resolve(pAdp);

      expect(await collectStream(await adaptive.streamText(tAdp))).toBe(
        await collectStream(await official.streamText(tOff)),
      );

      const oRes = await official.writeText(tOff, replacement);
      const aRes = await adaptive.writeText(tAdp, replacement);
      expect(aRes.operation).toBe(oRes.operation);
      expect(aRes.before).toBe(oRes.before);
      expect(aRes.after).toBe(oRes.after);
      expect((await fs.promises.readFile(pAdp)).equals(await fs.promises.readFile(pOff))).toBe(
        true,
      );
    }
  });

  it('keeps readText CRLF & CR raw on non-UTF-8 files even with >64KB leading valid UTF-8', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctx, {
      cwd: dir,
      diffBasisMaxBytes: 512 * 1024,
    });

    const ctx2 = new Context();
    ctxs.push(ctx2);
    const adaptiveGbk = new EncodingAdaptiveLocalFileSystem(ctx2, {
      cwd: dir,
      diffBasisMaxBytes: 512 * 1024,
      encodings: { 'tricky-chunk1.gbk.txt': 'gbk' },
    });

    // Chunk 1 starts with [0xC3, 0xA9] (valid UTF-8 "é" / GBK pair) followed by >64KB ASCII and then invalid-UTF-8 GBK
    const chunk1TrickyGbk = Buffer.concat([
      Buffer.from([0xc3, 0xa9]),
      Buffer.from('A'.repeat(70 * 1024), 'ascii'),
      iconv.encode('\r\n后面是纯正 GBK 中文段落！\r\n', 'gbk'),
    ]);
    const trickyPath = path.join(dir, 'tricky-chunk1.gbk.txt');
    await fs.promises.writeFile(trickyPath, chunk1TrickyGbk);
    const trickyTarget = await adaptiveGbk.resolve(trickyPath);

    const readWhole = await adaptiveGbk.readText(trickyTarget);
    expect(readWhole).toContain('\r\n后面是纯正 GBK 中文段落！\r\n');

    // Classic Mac CR file: readText returns raw \r
    const crText = '这是经典的老式换行测试第一行正文。\r这是第二行中文内容。\r这是第三行结尾。\r';
    const crPath = path.join(dir, 'mac-cr.gbk.txt');
    await fs.promises.writeFile(crPath, iconv.encode(crText, 'gbk'));
    const crTarget = await adaptive.resolve(crPath);
    expect(await adaptive.readText(crTarget)).toBe(crText);
  });

  it('completes non-UTF-8 moveFile and reports real state when cancelled after commit checkpoint, and aborts cleanly before commit', async () => {
    const dir = await makeTempDir();
    const { adaptive } = makeAdaptive(dir);

    const gbkText = '这是一段用于测试非 UTF-8 移动取消语义的 GBK 文本。\n第二行内容。\n';
    const src1 = path.join(dir, 'pre-abort.gbk.txt');
    const dst1 = path.join(dir, 'pre-abort-dst.gbk.txt');
    await fs.promises.writeFile(src1, iconv.encode(gbkText, 'gbk'));
    const ac1 = new AbortController();
    adaptive.internals.inspectBeforeMutation = () => {
      ac1.abort();
    };
    await expect(
      adaptive.moveFile(await adaptive.resolve(src1), await adaptive.resolve(dst1), {}, ac1.signal),
    ).rejects.toMatchObject({ code: 'FS_ABORTED' });
    expect(fs.existsSync(src1)).toBe(true);
    expect(fs.existsSync(dst1)).toBe(false);
    delete adaptive.internals.inspectBeforeMutation;

    // Post-commit cancellation: destination already published -> source must still be deleted & outcome returned
    const src2 = path.join(dir, 'post-commit.gbk.txt');
    const dst2 = path.join(dir, 'post-commit-dst.gbk.txt');
    await fs.promises.writeFile(src2, iconv.encode(gbkText, 'gbk'));
    const src2Target = await adaptive.resolve(src2);
    const dst2Target = await adaptive.resolve(dst2);
    const ac2 = new AbortController();
    const origStat = adaptive.stat.bind(adaptive);
    const statSpy = vi.spyOn(adaptive, 'stat').mockImplementation(async (t, s) => {
      // Trigger abort when post-publish stat on destination runs (destination already exists on disk)
      if (t.targetKey === dst2Target.targetKey && fs.existsSync(dst2)) {
        ac2.abort();
      }
      return await origStat(t, s);
    });

    const moveRes = await adaptive.moveFile(src2Target, dst2Target, {}, ac2.signal);
    statSpy.mockRestore();
    expect(moveRes.sourceDeleted).toBe(true);
    expect(moveRes.destination.operation).toBe('create');
    expect(fs.existsSync(src2)).toBe(false);
    expect((await fs.promises.readFile(dst2)).equals(iconv.encode(gbkText, 'gbk'))).toBe(true);

    // Partial success: destination published + abort arrived, but source removal fails with EACCES
    const src3 = path.join(dir, 'partial.gbk.txt');
    const dst3 = path.join(dir, 'partial-dst.gbk.txt');
    await fs.promises.writeFile(src3, iconv.encode(gbkText, 'gbk'));
    const ac3 = new AbortController();
    adaptive.internals.removeFile = async () => {
      ac3.abort();
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const partialRes = await adaptive.moveFile(
      await adaptive.resolve(src3),
      await adaptive.resolve(dst3),
      {},
      ac3.signal,
    );
    delete adaptive.internals.removeFile;
    expect(partialRes).toMatchObject({
      sourceDeleted: false,
      sourceFailure: { code: 'FS_PERMISSION_DENIED' },
    });
    expect(fs.existsSync(src3)).toBe(true);
    expect((await fs.promises.readFile(dst3)).equals(iconv.encode(gbkText, 'gbk'))).toBe(true);
  });

  it('rejects moveFile onto directory, provides non-UTF-8 deleteFile before basis, and honors path globs in encodings across read/edit/write', async () => {
    const dir = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);
    const adaptive = new EncodingAdaptiveLocalFileSystem(ctx, {
      cwd: dir,
      encodings: { 'legacy/**': 'shift_jis' },
    });

    const gbkSrcPath = path.join(dir, 'src.gbk.txt');
    const gbkText = '这是用于移动和删除基线测试的 GBK 文本。\r\n第二行。\r\n';
    await fs.promises.writeFile(gbkSrcPath, iconv.encode(gbkText, 'gbk'));
    const srcTarget = await adaptive.resolve(gbkSrcPath);

    const existingDir = path.join(dir, 'target-dir');
    await fs.promises.mkdir(existingDir);
    const dirDestTarget = await adaptive.resolve(existingDir);
    await expect(adaptive.moveFile(srcTarget, dirDestTarget, {})).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
    });

    // deleteFile returns non-UTF-8 before basis (normalized LF like official deleteFile)
    const delOut = await adaptive.deleteFile(srcTarget);
    expect(delOut.before).toBe('这是用于移动和删除基线测试的 GBK 文本。\n第二行。\n');

    // Path-scoped glob override applies to readText/editText/writeText when resolved relative to cwd
    const legacyDir = path.join(dir, 'legacy', 'nested');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    const sjisPath = path.join(legacyDir, 'sample.txt');
    const sjisOriginal = '日本語テスト行1\n日本語テスト行2\n';
    await fs.promises.writeFile(sjisPath, iconv.encode(sjisOriginal, 'shift_jis'));

    const sjisTarget = await adaptive.resolve('legacy/nested/sample.txt', { cwd: dir });
    expect(await adaptive.readText(sjisTarget)).toBe(sjisOriginal);
    expect(adaptive.encodingCache.getLatest(sjisTarget.targetKey)?.encoding).toBe('shift_jis');

    await adaptive.editText(sjisTarget, {
      oldString: '行1',
      newString: '行一',
      replaceAll: false,
    });
    const afterEditDisk = await fs.promises.readFile(sjisPath);
    expect(iconv.decode(afterEditDisk, 'shift_jis')).toBe('日本語テスト行一\n日本語テスト行2\n');

    await adaptive.writeText(sjisTarget, '上書きされたテキスト\n');
    const afterWriteDisk = await fs.promises.readFile(sjisPath);
    expect(iconv.decode(afterWriteDisk, 'shift_jis')).toBe('上書きされたテキスト\n');
  });
});
