import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it } from 'vitest';
import { EncodingAdaptiveSandboxedFileSystem } from '../src/fs/index.js';
import * as encodingPlugin from '../src/index.js';

describe('EncodingAdaptiveSandboxedFileSystem & sandbox policy integration', () => {
  const dirs: string[] = [];
  const ctxs: Context[] = [];

  async function makeTempDir(prefix = 'dsh-fs-enc-sbox-', baseDir = os.tmpdir()): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(baseDir, prefix));
    dirs.push(dir);
    return dir;
  }

  function registerFakeSandboxPolicy(ctx: Context, mode: SandboxMode, workspaceRoot: string) {
    class MockSandboxPolicy extends Service {
      readonly defaultMode = mode;
      readonly workspaceRoot = workspaceRoot;
      readonly additionalWritableRoots = undefined;
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

  afterEach(async () => {
    await Promise.all(ctxs.splice(0).map((c) => c.fiber.dispose()));
    await Promise.all(
      dirs.splice(0).map((d) => fs.promises.rm(d, { recursive: true, force: true })),
    );
  });

  it('denies all mutating operations on GBK files under read-only mode before modifying disk', async () => {
    const workspace = await makeTempDir();
    const gbkFile = path.join(workspace, 'data.gbk.txt');
    const gbkCopy = path.join(workspace, 'copy.gbk.txt');
    const origBytes = iconv.encode(
      '这是一段受只读沙箱保护的 GBK 测试文件内容。\n第二行内容\n',
      'gbk',
    );
    await fs.promises.writeFile(gbkFile, origBytes);

    const ctx = new Context();
    ctxs.push(ctx);
    registerFakeSandboxPolicy(ctx, 'read-only', workspace);

    await ctx.plugin(encodingPlugin, { cwd: workspace, sandbox: true }).await();

    const fsSvc = ctx.fs;
    expect(fsSvc).toBeInstanceOf(EncodingAdaptiveSandboxedFileSystem);
    expect(fsSvc.sandboxMode).toBe('read-only');

    const target = await fsSvc.resolve(gbkFile);
    const dest = await fsSvc.resolve(gbkCopy);

    // Reads are allowed
    expect(await fsSvc.readText(target)).toBe(
      '这是一段受只读沙箱保护的 GBK 测试文件内容。\n第二行内容\n',
    );

    // All mutations are denied with FS_SANDBOX_DENIED without altering bytes
    await expect(fsSvc.writeText(target, 'overwrite')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    });
    await expect(
      fsSvc.editText(target, { oldString: '第二行内容', newString: '改动', replaceAll: false }),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(
      fsSvc.patchText(target, [
        { lineNumber: 1, oldLines: ['第二行内容'], newLines: ['改动'], isEndOfFile: true },
      ]),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(fsSvc.deleteFile(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(fsSvc.moveFile(target, dest, {})).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    });

    expect((await fs.promises.readFile(gbkFile)).equals(origBytes)).toBe(true);
    expect(fs.existsSync(gbkCopy)).toBe(false);
  });

  it('allows in-workspace GBK edits and blocks outside-workspace & symlink escapes in workspace-write mode', async () => {
    const workspace = await makeTempDir('dsh-enc-ws-');
    // Use /var/tmp so outside directory is not inside OS tmpdir (/tmp), which workspace-write permits
    const outside = await makeTempDir('dsh-enc-out-', '/var/tmp');

    const inGbk = path.join(workspace, 'inside.gbk.txt');
    const outGbk = path.join(outside, 'secret.gbk.txt');
    const linkEscape = path.join(workspace, 'escape-link.txt');

    const inOrig = iconv.encode('工作区内中文 GBK 源文件测试内容。\n目标=旧值\n', 'gbk');
    const outOrig = iconv.encode('工作区外敏感 GBK 文件，不允许写入。\n目标=禁止修改\n', 'gbk');
    await fs.promises.writeFile(inGbk, inOrig);
    await fs.promises.writeFile(outGbk, outOrig);
    await fs.promises.symlink(outGbk, linkEscape);

    const ctx = new Context();
    ctxs.push(ctx);
    registerFakeSandboxPolicy(ctx, 'workspace-write', workspace);
    await ctx.plugin(encodingPlugin, { cwd: workspace, sandbox: true }).await();

    const fsSvc = ctx.fs;
    const inTarget = await fsSvc.resolve(inGbk);
    const outTarget = await fsSvc.resolve(outGbk);
    const linkTarget = await fsSvc.resolve(linkEscape);

    // In-workspace GBK edit succeeds
    await fsSvc.editText(inTarget, {
      oldString: '目标=旧值',
      newString: '目标=新值',
      replaceAll: false,
    });
    expect(
      (await fs.promises.readFile(inGbk)).equals(
        iconv.encode('工作区内中文 GBK 源文件测试内容。\n目标=新值\n', 'gbk'),
      ),
    ).toBe(true);

    // Outside-workspace GBK edit rejected
    await expect(
      fsSvc.editText(outTarget, {
        oldString: '目标=禁止修改',
        newString: '入侵',
        replaceAll: false,
      }),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });

    // Symlink inside workspace resolving outside workspace rejected
    await expect(
      fsSvc.editText(linkTarget, {
        oldString: '目标=禁止修改',
        newString: '逃逸',
        replaceAll: false,
      }),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });

    expect((await fs.promises.readFile(outGbk)).equals(outOrig)).toBe(true);
  });

  it('inherits EncodingAdaptiveLocalFileSystem -> LocalFileSystem and permits outside-workspace writes only under additionalWritableRoots or danger-full-access', async () => {
    const workspace = await makeTempDir('dsh-enc-ws2-');
    const extraRoot = await makeTempDir('dsh-enc-extra-', '/var/tmp');
    const blockedRoot = await makeTempDir('dsh-enc-blocked-', '/var/tmp');

    const extraGbk = path.join(extraRoot, 'allowed.gbk.txt');
    const blockedGbk = path.join(blockedRoot, 'blocked.gbk.txt');
    await fs.promises.writeFile(
      extraGbk,
      iconv.encode('这是一段位于额外可写根目录内的 GBK 编码中文测试文本。\nstatus=old\n', 'gbk'),
    );
    await fs.promises.writeFile(
      blockedGbk,
      iconv.encode(
        '这是一段位于受限根目录内的 GBK 编码中文测试文本，禁止越权写入。\nstatus=locked\n',
        'gbk',
      ),
    );

    const ctx = new Context();
    ctxs.push(ctx);
    registerFakeSandboxPolicy(ctx, 'workspace-write', workspace);
    await ctx.plugin(encodingPlugin, { cwd: workspace, sandbox: true }).await();

    const fsSvc = ctx.fs;
    expect(fsSvc).toBeInstanceOf(EncodingAdaptiveSandboxedFileSystem);

    const extraTarget = await fsSvc.resolve(extraGbk);
    const blockedTarget = await fsSvc.resolve(blockedGbk);

    await fsSvc.editText(
      extraTarget,
      { oldString: 'status=old', newString: 'status=updated', replaceAll: false },
      undefined,
      undefined,
      {
        mode: 'workspace-write',
        workspaceRoot: workspace,
        additionalWritableRoots: [extraRoot],
      },
    );
    expect(
      (await fs.promises.readFile(extraGbk)).equals(
        iconv.encode(
          '这是一段位于额外可写根目录内的 GBK 编码中文测试文本。\nstatus=updated\n',
          'gbk',
        ),
      ),
    ).toBe(true);

    await expect(
      fsSvc.editText(
        blockedTarget,
        { oldString: 'status=locked', newString: 'status=hacked', replaceAll: false },
        undefined,
        undefined,
        {
          mode: 'workspace-write',
          workspaceRoot: workspace,
          additionalWritableRoots: [extraRoot],
        },
      ),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });

    await fsSvc.editText(
      blockedTarget,
      { oldString: 'status=locked', newString: 'status=escalated', replaceAll: false },
      undefined,
      undefined,
      {
        mode: 'danger-full-access',
        workspaceRoot: workspace,
      },
    );
    expect(
      (await fs.promises.readFile(blockedGbk)).equals(
        iconv.encode(
          '这是一段位于受限根目录内的 GBK 编码中文测试文本，禁止越权写入。\nstatus=escalated\n',
          'gbk',
        ),
      ),
    ).toBe(true);
  });

  it('stays inactive until sandboxPolicy is provided, then activates cleanly', async () => {
    const workspace = await makeTempDir();
    const ctx = new Context();
    ctxs.push(ctx);

    const fork = ctx.plugin(encodingPlugin, { cwd: workspace, sandbox: true });
    expect(ctx.get('fs')).toBeUndefined();

    const policyFork = registerFakeSandboxPolicy(ctx, 'workspace-write', workspace);
    await policyFork.await();
    await fork.await();
    expect(ctx.get('fs')).toBeDefined();
    expect(ctx.fs).toBeInstanceOf(EncodingAdaptiveSandboxedFileSystem);
  });
});
