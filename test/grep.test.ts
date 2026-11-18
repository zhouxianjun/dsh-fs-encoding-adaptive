import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { TextBlock } from '@deepseek-ai/dsh-llm';
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
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
import type { GrepMatch } from '@deepseek-ai/dsh-tool-fs-search';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it } from 'vitest';
import * as encodingPlugin from '../src/index.js';
import { inspectFileEncodingForSearch } from '../src/search/inspect.js';

describe('Encoding-aware grep interception (tools/execute)', () => {
  const dirs: string[] = [];
  const ctxs: Context[] = [];

  async function makeTempDir(prefix = 'dsh-fs-enc-grep-'): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  async function setupSearchHarness(
    workspace: string,
    opts: { withSpill?: boolean; sessionCwd?: string } = {},
  ) {
    const withSpill = opts.withSpill ?? false;
    const sessionCwd = opts.sessionCwd ?? workspace;
    const ctx = new Context();
    ctxs.push(ctx);

    class MockWorkingDirectory extends Service {
      constructor(c: Context) {
        super(c, 'workingDirectory');
      }
      async ensure(): Promise<string> {
        return sessionCwd;
      }
    }

    class MockSandboxPolicy extends Service {
      readonly defaultMode = 'workspace-write';
      constructor(c: Context) {
        super(c, 'sandboxPolicy');
      }
      resolve() {
        return { mode: 'workspace-write' as const, workspaceRoot: workspace };
      }
    }

    ctx.plugin(MockWorkingDirectory);
    ctx.plugin(MockSandboxPolicy);
    ctx.plugin(ToolsService, {});
    const executorFork = ctx.plugin(nativeExecutor);
    ctx.plugin(SystemPrompt, {});
    ctx.plugin(LocalSubprocessRuntime);
    if (withSpill) {
      const spillDir = await makeTempDir('dsh-enc-spill-');
      ctx.plugin(LocalSpillStore, { root: spillDir, cleanupPeriodDays: 0 });
    }
    await executorFork.await();
    await ctx
      .plugin(encodingPlugin, {
        sandbox: false,
        cwd: workspace,
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

    const tools = ctx.tools;
    return { ctx, tools };
  }

  async function runGrep(
    tools: ToolsService,
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    agent?: unknown,
  ) {
    const batch = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId(id),
          name: 'grep',
          arguments: JSON.stringify(args),
        },
      ],
      ...(agent !== undefined ? { agent: agent as never } : {}),
      signal,
    });
    return batch.results[0]!.result;
  }

  afterEach(async () => {
    await Promise.all(ctxs.splice(0).map((c) => c.fiber.dispose()));
    await Promise.all(
      dirs.splice(0).map((d) => fs.promises.rm(d, { recursive: true, force: true })),
    );
  });

  it('finds non-ASCII and mixed matches across UTF-8, GBK, Big5, Shift-JIS, EUC-KR, UTF-16LE, and Windows-1251 while skipping binaries', async () => {
    const workspace = await makeTempDir();

    await fs.promises.writeFile(
      path.join(workspace, '01-utf8.txt'),
      'UTF-8 模块关键字：FIND_ME_中文\n普通行\n',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(workspace, '02-gbk.txt'),
      iconv.encode(
        '这是一段 GBK 编码模块注释。\nFIND_ME_中文 与 简体中文密钥\n第二处 FIND_ME_中文 匹配\n',
        'gbk',
      ),
    );
    await fs.promises.writeFile(
      path.join(workspace, '03-big5.txt'),
      iconv.encode('這是繁體中文 Big5 測試檔案。\n繁體關鍵字內容在這裡\n', 'big5'),
    );
    await fs.promises.writeFile(
      path.join(workspace, '04-sjis.txt'),
      iconv.encode('これは日本語の Shift-JIS テストです。\n日本語キーワード発見\n', 'shift_jis'),
    );
    await fs.promises.writeFile(
      path.join(workspace, '05-euckr.txt'),
      iconv.encode('이것은 한국어 EUC-KR 테스트 파일입니다.\n한국어키워드발견\n', 'euc-kr'),
    );
    await fs.promises.writeFile(
      path.join(workspace, '06-utf16.txt'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        iconv.encode('UTF-16LE 文档头部\r\nFIND_ME_中文 UTF16 匹配行\r\n', 'utf16-le'),
      ]),
    );
    await fs.promises.writeFile(
      path.join(workspace, '07-win1251.txt'),
      iconv.encode(
        'Привет мир! Тестовый файл Windows-1251 с русским текстом.\nРусскоеКлючевоеСлово\n',
        'windows-1251',
      ),
    );
    // Genuine binary containing high bytes & NUL should never confuse search
    await fs.promises.writeFile(
      path.join(workspace, '08-binary.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, 0xd6, 0xd0, 0xce, 0xc4]),
    );

    const { tools } = await setupSearchHarness(workspace);
    const controller = new AbortController();

    // 1. CJK pattern (misses official UTF-8 ripgrep on GBK/UTF-16LE, rescued by grouped --encoding runs)
    const cjkRes = await runGrep(
      tools,
      'g1',
      { pattern: 'FIND_ME_中文', path: workspace },
      controller.signal,
    );
    expect(cjkRes.isError).toBe(false);
    const cjkMatches = ((cjkRes.value as unknown as { matches: GrepMatch[] }).matches ?? []).map(
      (m) => ({
        file: path.basename(m.path),
        lineNumber: m.lineNumber,
        line: m.line,
      }),
    );
    expect(cjkMatches).toHaveLength(4);
    expect(cjkMatches).toEqual(
      expect.arrayContaining([
        { file: '01-utf8.txt', lineNumber: 1, line: 'UTF-8 模块关键字：FIND_ME_中文' },
        { file: '02-gbk.txt', lineNumber: 2, line: 'FIND_ME_中文 与 简体中文密钥' },
        { file: '02-gbk.txt', lineNumber: 3, line: '第二处 FIND_ME_中文 匹配' },
        { file: '06-utf16.txt', lineNumber: 2, line: 'FIND_ME_中文 UTF16 匹配行' },
      ]),
    );

    // 2. Pattern hitting ASCII prefix in GBK during Step 1 ("FIND_ME_") replaced cleanly in-place without duplicates
    const mixedRes = await runGrep(
      tools,
      'g2',
      { pattern: 'FIND_ME_', path: workspace },
      controller.signal,
    );
    expect(mixedRes.isError).toBe(false);
    const mixedMatches = (mixedRes.value as unknown as { matches: GrepMatch[] }).matches;
    const gbkRows = mixedMatches.filter((m) => path.basename(m.path) === '02-gbk.txt');
    expect(gbkRows).toHaveLength(2);
    expect(gbkRows[0]!.line).toContain('简体中文密钥');
    expect(gbkRows[1]!.line).toContain('第二处');

    // 3. Big5, Shift-JIS, EUC-KR, Windows-1251 + include filter
    for (const [pattern, include, expectedFile] of [
      ['繁體關鍵字', '*.txt', '03-big5.txt'],
      ['日本語キーワード', '*.txt', '04-sjis.txt'],
      ['한국어키워드', '*.txt', '05-euckr.txt'],
      ['РусскоеКлючевоеСлово', '*.txt', '07-win1251.txt'],
    ] as const) {
      const res = await runGrep(
        tools,
        `g-${expectedFile}`,
        { pattern, path: workspace, include },
        controller.signal,
      );
      expect(res.isError).toBe(false);
      const matches = (res.value as unknown as { matches: GrepMatch[] }).matches;
      expect(matches.some((m) => path.basename(m.path) === expectedFile)).toBe(true);
    }
  });

  it('respects official 250-match cap and spill file generation when merged non-UTF-8 results exceed GREP_MAX_MATCHES', async () => {
    const workspace = await makeTempDir();
    const lines = ['// 这是用于测试超限截断的 GBK 中文源文件'];
    for (let i = 1; i <= 280; i++) {
      lines.push(`第 ${i} 行：命中标记_中文条目`);
    }
    await fs.promises.writeFile(
      path.join(workspace, 'many.gbk.txt'),
      iconv.encode(lines.join('\n') + '\n', 'gbk'),
    );

    const { tools } = await setupSearchHarness(workspace, { withSpill: true });
    const controller = new AbortController();

    const res = await runGrep(
      tools,
      'g-spill',
      {
        pattern: '命中标记_中文条目',
        path: workspace,
      },
      controller.signal,
      { session: { header: { id: 'test-session-1' } } },
    );
    expect(res.isError).toBe(false);
    const matches = (res.value as unknown as { matches: GrepMatch[] }).matches;
    expect(matches).toHaveLength(280);

    const rendered = (res.content[0] as TextBlock).text;
    expect(rendered).toContain('Found 250 of 280 matches');
    expect(rendered).toContain('Line 251:');
    expect(rendered).not.toContain('Line 252:');
    expect(rendered).toContain('grep-results.txt');
  });

  it('finds BOM-less pure-ASCII UTF-16LE/BE, skips large (>64KB) split-UTF-8 & binary files safely, and batches large rg file lists', async () => {
    const workspace = await makeTempDir();

    // BOM-less pure-ASCII UTF-16LE & UTF-16BE files (bytes all < 0x80)
    await fs.promises.writeFile(
      path.join(workspace, 'ascii-le.txt'),
      iconv.encode('alpha line\nFIND_ASCII_UTF16LE_NEEDLE\nomega\n', 'utf16-le'),
    );
    await fs.promises.writeFile(
      path.join(workspace, 'ascii-be.txt'),
      iconv.encode('alpha line\nFIND_ASCII_UTF16BE_NEEDLE\nomega\n', 'utf16-be'),
    );

    // >64KB UTF-8 file with a 3-byte Chinese char spanning the 65536-byte boundary
    const splitPrefix = Buffer.alloc(65534, 0x41);
    const splitUtf8 = Buffer.concat([
      splitPrefix,
      Buffer.from('中FIND_SPLIT_UTF8_NEEDLE\n', 'utf8'),
    ]);
    const splitUtf8Path = path.join(workspace, 'large-split.utf8.txt');
    await fs.promises.writeFile(splitUtf8Path, splitUtf8);

    const ac = new AbortController();
    expect(
      await inspectFileEncodingForSearch(splitUtf8Path, 'large-split.utf8.txt', ac.signal),
    ).toEqual({
      kind: 'utf8',
    });

    // Aborted signal throws FS_ABORTED
    const abortedAc = new AbortController();
    abortedAc.abort();
    await expect(
      inspectFileEncodingForSearch(splitUtf8Path, 'large-split.utf8.txt', abortedAc.signal),
    ).rejects.toMatchObject({ code: 'FS_ABORTED' });

    // Large binary file > 64KB (trailing needle must not match in grep either)
    const bigBin = Buffer.concat([
      Buffer.from('PNG\0binary', 'latin1'),
      Buffer.alloc(200 * 1024, 0x00),
      Buffer.from('FIND_ASCII_UTF16LE_NEEDLE', 'ascii'),
    ]);
    const bigBinPath = path.join(workspace, 'large.bin');
    await fs.promises.writeFile(bigBinPath, bigBin);
    expect(await inspectFileEncodingForSearch(bigBinPath, 'large.bin')).toEqual({
      kind: 'binary',
    });

    // 130 Shift-JIS files in sjis-batch/ searched end-to-end across multiple batches + UTF-16LE/BE
    const sjisDir = path.join(workspace, 'sjis-batch');
    await fs.promises.mkdir(sjisDir);
    for (let i = 0; i < 130; i++) {
      const marker = i === 129 ? 'FIND_ASCII_UTF16_BATCH_END' : 'other';
      await fs.promises.writeFile(
        path.join(sjisDir, `f-${String(i).padStart(3, '0')}.txt`),
        iconv.encode(`日本語データ ${marker}\n`, 'shift_jis'),
      );
    }

    const { tools } = await setupSearchHarness(workspace);
    const controller = new AbortController();

    const resUtf16 = await runGrep(
      tools,
      'g-ascii-utf16',
      { pattern: 'FIND_ASCII_UTF16(LE|BE)_NEEDLE', path: workspace },
      controller.signal,
    );
    expect(resUtf16.isError).toBe(false);
    const matches16 = (resUtf16.value as unknown as { matches: GrepMatch[] }).matches;
    expect(matches16.map((m) => path.basename(m.path)).sort()).toEqual([
      'ascii-be.txt',
      'ascii-le.txt',
    ]);

    const resBatch = await runGrep(
      tools,
      'g-sjis-batch',
      { pattern: 'FIND_ASCII_UTF16_BATCH_END', path: sjisDir },
      controller.signal,
    );
    expect(resBatch.isError).toBe(false);
    const matchesBatch = (resBatch.value as unknown as { matches: GrepMatch[] }).matches;
    expect(matchesBatch.map((m) => path.basename(m.path))).toEqual(['f-129.txt']);
  });

  it('keeps official display paths when session workingDirectory is a subdirectory', async () => {
    const workspace = await makeTempDir();
    const legacyNested = path.join(workspace, 'legacy', 'nested');
    await fs.promises.mkdir(legacyNested, { recursive: true });
    const gbkFile = path.join(legacyNested, 'sample.txt');
    const gbkLine = '这是一段用于测试子目录相对路径显示的 GBK 中文搜索行：FIND_中文';
    await fs.promises.writeFile(gbkFile, iconv.encode(`${gbkLine}\n`, 'gbk'));

    const controller = new AbortController();
    const agent = { session: { header: { id: 'test-session-cwd' } } };

    const rootHarness = await setupSearchHarness(workspace, {
      sessionCwd: workspace,
    });
    const rootRes = await runGrep(
      rootHarness.tools,
      'g-root',
      { pattern: 'FIND_中文' },
      controller.signal,
      agent,
    );
    expect(rootRes.isError).toBe(false);
    expect((rootRes.value as unknown as { matches: GrepMatch[] }).matches).toEqual([
      {
        path: path.join('legacy', 'nested', 'sample.txt'),
        lineNumber: 1,
        line: gbkLine,
      },
    ]);

    const subHarness = await setupSearchHarness(workspace, {
      sessionCwd: path.join(workspace, 'legacy'),
    });
    const subRes = await runGrep(
      subHarness.tools,
      'g-sub',
      { pattern: 'FIND_中文' },
      controller.signal,
      agent,
    );
    expect(subRes.isError).toBe(false);
    expect((subRes.value as unknown as { matches: GrepMatch[] }).matches).toEqual([
      {
        path: path.join('nested', 'sample.txt'),
        lineNumber: 1,
        line: gbkLine,
      },
    ]);

    const leafHarness = await setupSearchHarness(workspace, {
      sessionCwd: legacyNested,
    });
    const leafRes = await runGrep(
      leafHarness.tools,
      'g-leaf',
      { pattern: 'FIND_中文' },
      controller.signal,
      agent,
    );
    expect(leafRes.isError).toBe(false);
    expect((leafRes.value as unknown as { matches: GrepMatch[] }).matches).toEqual([
      {
        path: 'sample.txt',
        lineNumber: 1,
        line: gbkLine,
      },
    ]);
  });
});
