---
name: dsh-upstream-sync
description: >-
  Check and synchronize dsh-fs-encoding-adaptive with updated @deepseek-ai/dsh
  host packages and the upstream deepseek-harness repository. Use whenever the
  user reports that dsh or local deepseek-harness source was updated, asks to
  upgrade @deepseek-ai/dsh-* dependencies, or asks to verify copied/mirrored
  upstream code in src/upstream/, src/fs/, src/search/, or src/read-notice.ts.
---

# DSH Upstream Sync & Host Compatibility Check

This skill guides read-only comparison, dependency alignment, selective synchronization, and verification for `dsh-fs-encoding-adaptive` whenever the host `dsh` installation or local `deepseek-harness` checkout updates.

## Constraints

- Never modify files inside the upstream `deepseek-harness` checkout.
- Never couple `package.json` or runtime imports to internal upstream paths; only import documented package exports (`@deepseek-ai/dsh-*`).
- Never fabricate APIs or assume unconfirmed framework capabilities: if an API, behavior, or upstream source/doc path cannot be verified from installed packages or the located `deepseek-harness` repo, state the gap explicitly and ask the user.
- Never bump this package's own `version` in `package.json` unless explicitly asked for a release.
- Preserve all encoding-adaptive guarantees (UTF-8 passthrough via `super.*`, byte-exact non-UTF-8 round-trips, BOM/EOL preservation, sandbox containment, atomic writes, and `FsVersion` parity).

## Step 1: Locate Upstream Source & Inspect Versions

1. Resolve the local `deepseek-harness` repo in this order:
   - Explicit path argument or `DSH_REPO` environment variable.
   - If `DSH_REPO` is unset, search parent directories of this repo (and their immediate subdirectories) and the user's home directory (`~`, shallow non-hidden subdirectories) for a directory named `deepseek-harness` or a root `package.json` with `"name": "@deepseek-ai/dsh-root"`.
   - **If not found**, stop and ask the user for the actual `deepseek-harness` / documentation path before making assumptions about unreleased upstream changes.
2. Run [check-upstream.mjs](./scripts/check-upstream.mjs) (or inspect directly with `node` / `git -C "$DSH_REPO"`):

```bash
node .agents/skills/dsh-upstream-sync/scripts/check-upstream.mjs [optional-path-to-dsh-repo]
```

Treat the script output as a starting index only — always inspect full diffs with `git -C "$DSH_REPO" diff` for any affected area rather than relying solely on `--stat`.

## Step 2: Distinguish Host Release vs Unreleased `master`

1. Compare the **global `dsh` host version** (what `dsh` resolves at runtime via peer dependencies) with **workspace `node_modules`** and **`deepseek-harness` tags / `HEAD`**.
2. Distinguish changes already shipped in the target published tag (e.g. `dsh-v0.2.2-rc.3`) from unreleased commits on `master`.
3. Do not import runtime exports from `@deepseek-ai/*` that are absent from the lowest version allowed by `package.json` `peerDependencies`. If a newly adopted upstream helper requires a newer `@deepseek-ai/*` version, either upgrade `peerDependencies` + `devDependencies` (if the host already ships it) or provide a compatible local fallback.

## Step 3: Compare Copied & Mirrored Files (Read-Only)

Inspect diffs in `$DSH_REPO` for every copied or mirrored area:

| Local File | Upstream Source (`$DSH_REPO`) | Why Copied / Mirrored |
| --- | --- | --- |
| `src/upstream/win32.ts` | `packages/fs/fs-local/src/win32.ts` | Not exported by `@deepseek-ai/dsh-fs-local` |
| `src/upstream/atomic-write.ts` | `packages/fs/fs-local/src/fsio.ts` | Raw `Buffer` write + `statFn` -> `LocalFileSystem.stat` + `.dsh-enc-tmp-*` cleanup; `fsio.ts` is unexported |
| `src/upstream/sandbox-fence.ts` | `packages/fs/fs-sandbox/src/containment.ts` + `src/index.ts` (`checkedTarget`) | `@deepseek-ai/dsh-fs-sandbox` only exports `SandboxedFileSystem` subclass, not standalone helpers |
| `src/fs/sandbox.ts` | `packages/fs/fs-sandbox/src/index.ts` | Single inheritance requires extending `EncodingAdaptiveLocalFileSystem` |
| `src/fs/locks.ts` | `packages/fs/fs-local/src/index.ts` (`withLock` / `withLocks`) | Parent `locks` map is `private`; outer reentrant lock avoids deadlock |
| `src/fs/edit.ts` | `packages/fs/fs-local/src/fsio.ts` (`applyLiteralEdit`) | Unexported upstream + needs classic Mac `CR` EOL support |
| `src/fs/local.ts` | `packages/fs/fs-local/src/index.ts` | Non-UTF-8 fallback paths mirror upstream guards, diff basis, abort checkpoints, and `moveFile` outcome |
| `src/search/grep.ts` | `packages/fs/tool-fs-search/src/grep.ts`, `search-core.ts` | `tools/execute` grep hook contract & `runRipgrep` / `parseGrepArgs` / `parseGrepMatches` APIs |
| `src/read-notice.ts` | `packages/fs/tool-fs/src/read.ts`, `packages/fs/tool-str-replace-editor/src/index.ts`, `packages/llm/llm/src/message.ts` | `read` / `str_replace_editor` (`view`) arg names and `createUserMessage` contract |
| `cordis.patch.yml` | `packages/bundle/base/cordis.patch.yml` | Built-in `fs-sandbox` plugin entry ID |

Focus especially on:
- Error taxonomy (`FS_ERROR_CODES`, `fsErrorFromErrno`, `FsError` messages/causes)
- Version guards (`FS_STALE_VERSION`, `FS_NOT_OBSERVED`), lock ordering, and `AbortSignal` checkpoints
- Atomic staging/cleanup (`writeFileAtomic`, Windows `copyFileDaclWin32` / `replaceFileWin32`, `createIfAbsent` hard-link handling)
- Sandbox containment (`isPathUnder`, `writableRoots`, `checkedTarget`)
- Search tool concurrency/args/spill hooks and `read` / `str_replace_editor` argument shapes

## Step 4: Synchronize Dependencies & Code

1. If upgrading workspace dependencies to match the updated host release:
   - Update `@deepseek-ai/*` ranges in `package.json` (`devDependencies` and, when required by new host APIs/contracts, `peerDependencies`).
   - Run `pnpm install` and `pnpm update "@deepseek-ai/*"` as needed, then run `pnpm peers check`.
2. Apply relevant upstream fixes to `src/upstream/` and `src/fs/` while keeping intentional encoding-adaptive deviations intact.
3. Update the upstream package/version or commit provenance comments in `src/upstream/*.ts` headers.
4. Add or adjust tests only for concrete regression risks or changed boundary contracts.

## Step 5: Verify End-to-End

Run the full validation suite and a real host startup smoke test after the final edit:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test
timeout 5s dsh --profile enc-test --port 0 --no-open 2>&1 || true
```

Confirm `dsh` starts without any `did not activate` or `failed to import` warnings.

## Step 6: Report Format

Summarize:
1. Compared revisions (global `dsh` version, workspace dependency version, `$DSH_REPO` tag & `HEAD`)
2. Changes adopted vs deferred/skipped (with reasons)
3. Any unconfirmed framework capabilities or missing paths (explicitly flagged, never guessed)
4. Exact commands run after the final edit and their observed results
