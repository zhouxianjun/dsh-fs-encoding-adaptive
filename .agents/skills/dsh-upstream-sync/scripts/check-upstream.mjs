import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const UPSTREAM_CHECK_PATHS = [
  'packages/fs',
  'packages/sandbox',
  'packages/llm/llm',
  'packages/bundle/base/cordis.patch.yml',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveGlobalDshRoot() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const dshBin = run(whichCmd, ['dsh']);
  if (dshBin) {
    const firstBin = dshBin.split(/\r?\n/u)[0]?.trim();
    if (firstBin) {
      const realBin = fs.realpathSync(firstBin);
      let dir = path.dirname(realBin);
      for (let i = 0; i < 6; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath) && readJson(pkgPath).name === '@deepseek-ai/dsh') {
          return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
    }
  }

  const npmRoot = run('npm', ['root', '-g']);
  if (npmRoot) {
    const candidate = path.join(npmRoot, '@deepseek-ai', 'dsh');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

function isDshRootDir(dirPath) {
  const pkgPath = path.join(dirPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return false;
  }
  try {
    return readJson(pkgPath).name === '@deepseek-ai/dsh-root';
  } catch {
    return false;
  }
}

function matchesUpstreamRepo(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false;
  }
  if (isDshRootDir(dirPath)) {
    return true;
  }
  return (
    path.basename(dirPath) === 'deepseek-harness' &&
    fs.existsSync(path.join(dirPath, '.git'))
  );
}

function listChildDirs(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function findUpstreamRepo(cliArg) {
  const explicit = cliArg || process.env.DSH_REPO;
  if (explicit) {
    const resolved = path.resolve(explicit);
    return matchesUpstreamRepo(resolved) ? resolved : null;
  }

  const checked = new Set();
  const checkCandidate = (candidate) => {
    const resolved = path.resolve(candidate);
    if (checked.has(resolved)) {
      return false;
    }
    checked.add(resolved);
    return matchesUpstreamRepo(resolved);
  };

  // 1. Walk parent directories of this repo (and their immediate subdirectories).
  let current = path.dirname(repoRoot);
  while (true) {
    if (checkCandidate(current)) {
      return current;
    }
    for (const child of listChildDirs(current)) {
      if (checkCandidate(child)) {
        return child;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // 2. Scan user home directory up to 2 levels deep (skipping hidden dirs and node_modules).
  const home = os.homedir();
  for (const level1 of listChildDirs(home)) {
    if (checkCandidate(level1)) {
      return level1;
    }
    for (const level2 of listChildDirs(level1)) {
      if (checkCandidate(level2)) {
        return level2;
      }
    }
  }

  return null;
}

function getInstalledPkgVersion(baseNodeModules, fullPkgName) {
  const pkgPath = path.join(baseNodeModules, ...fullPkgName.split('/'), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  return readJson(pkgPath).version ?? null;
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function main() {
  const globalDshRoot = resolveGlobalDshRoot();
  const wsPkg = readJson(path.join(repoRoot, 'package.json'));
  const wsNm = path.join(repoRoot, 'node_modules');
  const globalNm = globalDshRoot ? path.join(globalDshRoot, 'node_modules') : null;

  printSection('Plugin & Host Overview');
  console.log(`plugin: ${wsPkg.name}@${wsPkg.version}`);
  console.log(
    `global dsh: ${globalDshRoot ? `${readJson(path.join(globalDshRoot, 'package.json')).version} (${globalDshRoot})` : 'NOT FOUND'}`,
  );

  const trackedPkgs = new Set([
    ...Object.keys(wsPkg.dependencies ?? {}),
    ...Object.keys(wsPkg.devDependencies ?? {}),
    ...Object.keys(wsPkg.peerDependencies ?? {}),
  ]);
  const dshPkgs = [...trackedPkgs]
    .filter((pkg) => pkg.startsWith('@deepseek-ai/dsh-'))
    .sort();

  printSection('Declared @deepseek-ai/dsh-* Versions (workspace vs global dsh)');
  for (const fullName of dshPkgs) {
    const wsVer = getInstalledPkgVersion(wsNm, fullName) ?? 'not installed';
    const gVer = globalNm ? (getInstalledPkgVersion(globalNm, fullName) ?? 'missing') : 'n/a';
    const peerSpec = wsPkg.peerDependencies?.[fullName] ?? '-';
    const mismatch = globalNm && gVer !== 'missing' && wsVer !== gVer ? ' [DIFF]' : '';
    console.log(
      `  ${fullName.padEnd(38)} ws=${wsVer.padEnd(14)} host=${gVer.padEnd(14)} peer="${peerSpec}"${mismatch}`,
    );
  }

  printSection('src/upstream Provenance Headers');
  const upstreamDir = path.join(repoRoot, 'src', 'upstream');
  if (fs.existsSync(upstreamDir)) {
    for (const file of fs.readdirSync(upstreamDir).sort()) {
      const fullPath = path.join(upstreamDir, file);
      if (!fs.statSync(fullPath).isFile()) {
        continue;
      }
      const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/u).slice(0, 8);
      const refLine = lines.find((line) => line.includes('@deepseek-ai/')) ?? lines[1] ?? '';
      console.log(`  src/upstream/${file}: ${refLine.replace(/^\s*\*\s?/u, '').trim()}`);
    }
  }

  const upstreamRepo = findUpstreamRepo(process.argv[2]);
  printSection('Upstream Checkout (DSH_REPO)');
  if (!upstreamRepo) {
    console.log(
      '  NOT FOUND — set DSH_REPO or pass the path to deepseek-harness (@deepseek-ai/dsh-root), or ask the user for the actual path.',
    );
    return;
  }

  const headSha = run('git', ['-C', upstreamRepo, 'rev-parse', '--short', 'HEAD']);
  const headDesc = run('git', ['-C', upstreamRepo, 'describe', '--tags', '--always']);
  console.log(`  path: ${upstreamRepo}`);
  console.log(`  HEAD: ${headSha ?? 'unknown'} (${headDesc ?? 'unknown'})`);

  const wsFsVer = getInstalledPkgVersion(wsNm, '@deepseek-ai/dsh-fs');
  const hostFsVer = globalNm ? getInstalledPkgVersion(globalNm, '@deepseek-ai/dsh-fs') : null;
  const wsTag = wsFsVer ? `dsh-v${wsFsVer}` : null;
  const hostTag = hostFsVer ? `dsh-v${hostFsVer}` : null;

  const hasWsTag = wsTag && run('git', ['-C', upstreamRepo, 'rev-parse', '--verify', wsTag]) !== null;
  const hasHostTag =
    hostTag && run('git', ['-C', upstreamRepo, 'rev-parse', '--verify', hostTag]) !== null;

  if (hasWsTag && hasHostTag && wsTag !== hostTag) {
    printSection(`Upstream Diff: ${wsTag}..${hostTag}`);
    const stat = run('git', [
      '-C',
      upstreamRepo,
      'diff',
      '--stat',
      `${wsTag}..${hostTag}`,
      '--',
      ...UPSTREAM_CHECK_PATHS,
    ]);
    console.log(stat || '  (no changes in tracked upstream paths)');
  }

  const baseTag = hasHostTag ? hostTag : hasWsTag ? wsTag : null;
  if (baseTag) {
    printSection(`Upstream Unreleased Diff: ${baseTag}..HEAD`);
    const stat = run('git', [
      '-C',
      upstreamRepo,
      'diff',
      '--stat',
      `${baseTag}..HEAD`,
      '--',
      ...UPSTREAM_CHECK_PATHS,
    ]);
    console.log(stat || '  (no changes in tracked upstream paths)');
  }
}

main();
