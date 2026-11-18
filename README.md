# dsh-fs-encoding-adaptive

**English** | [简体中文](./README.zh.md)

Encoding-adaptive `FileSystem` provider, `ctx.fsEncoding` service, and `grep` enhancement plugin for DeepSeek Harness (`dsh`).

## Design Principles

The project's goal is to preserve official DSH filesystem behavior while extending non-UTF-8 reading, writing, and search. Outside these encoding extensions, operations delegate to official public APIs or inherit their implementation.

- Without a user-selected encoding, preserve native behavior and supplement non-UTF-8 support.
- An encoding selected through configuration, a resolver callback, or `createText` is an intentional user choice, including rules for existing pure ASCII files. Honor that choice within the boundaries below while retaining official sandbox, version, atomic-write, and error protections.
- Existing non-ASCII valid UTF-8 and UTF-8 BOM files remain protected from broad encoding rules and use the native UTF-8 path.

- **Default UTF-8 & UTF-8 BOM protection**: When no explicit rule is configured, files valid under official `LocalFileSystem` (UTF-8, UTF-8 BOM `EF BB BF`, ASCII, new creates) pass directly through `super.*` public methods. Even when encoding rules (`resolveEncoding` callback or `config.encodings`) are configured, existing regular files containing **non-ASCII valid UTF-8 characters or a UTF-8 BOM** remain protected on the native UTF-8 path. Streaming (`streamText`) is not enhanced and inherits the official UTF-8 implementation directly.
- **Precedence (`callback > config.encodings > auto-detection`) with unified versioned cache**:
  - `resolveEncoding` callback (sync or async) takes precedence over `config.encodings` glob rules, which take precedence over BOM/`chardet` auto-detection.
  - Ordinary callback errors or unsupported return values log a warning and fall back to `config.encodings` -> auto-detection; cancellation (`AbortSignal` / `FS_ABORTED`) propagates `FS_ABORTED`. Once an encoding is selected, decode, lossless round-trip, or strict-encode failures do not silently select another encoding. When no encoding is selected and old content cannot be detected as supported text, ordinary full-file overwrites retain the native UTF-8 overwrite behavior.
  - Resolved encodings (including explicit `'utf8'` results) are cached per `targetKey` + `FsVersion` across filesystem operations (`createText`, `readText`, `writeText`, `editText`, `patchText`), and invalidated on `deleteFile`, `moveFile`, version changes, or rule/callback updates. `grep` runs pure BOM/`chardet` auto-detection independently of `encodingCache`, `config.encodings`, and `resolveEncoding`.
  - Configured rules apply proactively to **new files** and **takeover-eligible existing files** (pure ASCII without UTF-8 BOM, or non-UTF-8 bytes interpreted directly in the configured encoding — without implicit ASCII-to-UTF-16 conversion).
  - Ordinary `moveFile` preserves source bytes/encoding without auto-transcoding to destination path rules.
- **Explicit file creation (`ctx.fsEncoding.createText`)**: Creates new files (`createIfAbsent` semantics: `FS_NOT_OBSERVED` if a regular file already exists) in an explicit `'utf8' | NonUtf8Encoding` without auto-adding BOMs, enforcing `sandboxPolicy` (`checkedTarget`) on both UTF-8 and non-UTF-8 paths.
- **Single inheritance chain without private-member access**: `EncodingAdaptiveSandboxedFileSystem` extends `EncodingAdaptiveLocalFileSystem` (which extends official `LocalFileSystem`), delegating only public APIs and isolating upstream-synced helpers (`sandbox-fence.ts` and `atomic-write.ts`) under `src/upstream/`.
- **Two-stage model guidance without replacing official tools**: When `systemPrompt` is mounted, a lightweight, scope-aware `tool:fs-encoding-adaptive` section informs the model upfront which visible built-in filesystem and search tools (`read`, `write`, `edit`, `apply_patch`, `str_replace_editor`, `grep`) support the 16 non-UTF-8 encodings beyond their base UTF-8 tool schemas; reading a non-UTF-8 file via `read` or `str_replace_editor` (`view`) then attaches a per-file notice reporting its encoding, BOM, line endings, and mutation safety rules.
- **Lossless mutation safety**:
  - Non-UTF-8 reads pair bytes with the provider's official `FsVersion` using `stat1 -> readFile -> stat2` checks.
  - Low-confidence detections reject mutations unless explicitly pinned via callback or `config.encodings`.
  - Mixed line endings (`LF` + `CRLF` / `CR`) reject edits/patches to prevent EOL corruption.
  - Full-pipeline round-trip verification (`encode(restoreEol(normalizeEol(decode(raw)))) === raw`) runs before every non-UTF-8 edit/patch.
  - Strict write encoding rejects unmappable characters instead of emitting `?` placeholders.
  - `writeBytesAtomic` stages on the same filesystem, preserves existing POSIX file mode, cleans dead-PID `.dsh-enc-tmp-*` directories, and re-checks an expected `FsVersion` before replacement. Creation uses an atomic no-replace `link` operation.

## Search Encoding Detection

Search first runs the official search, then supplements non-UTF-8 results using byte inspection, BOM detection, and `chardet` candidates. It does not use filesystem encoding rules, resolver callbacks, or the filesystem encoding cache.

UTF-8 is checked first. For other bytes, the plugin validates supported candidates in `chardet` ranking order; GBK is not a default fallback. Automatic detection can misidentify short or ambiguous content: GBK-encoded `FIND_中文` can be interpreted as ISO-8859-1 (`FIND_ÖÐÎÄ`), causing a search for `中文` to miss it. Successful byte round-tripping confirms a reversible interpretation, not the author's intended encoding.

## Supported 16 Non-UTF-8 Encodings

| Family      | Config / Canonical Names                        | `ripgrep --encoding` Label                      |
| :---------- | :---------------------------------------------- | :---------------------------------------------- |
| UTF-16      | `utf16le`, `utf16be`                            | `utf-16le`, `utf-16be`                          |
| East Asian  | `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-kr` | `gbk`, `gb18030`, `big5`, `shift-jis`, `euc-kr` |
| Single-byte | `windows-1250` ~ `windows-1257`, `iso-8859-1`   | `windows-1250` ~ `windows-1257`, `iso-8859-1`   |

## Service API (`ctx.fsEncoding`)

Mounted synchronously with the active `FileSystem` service:

- `version: string` — current package version.
- `requireActiveFs(): EncodingAdaptiveLocalFileSystem` — returns the active filesystem instance (the sandboxed subclass when sandbox enforcement is enabled); throws `FS_IO_ERROR` when the filesystem is not active.
- `createText(target, content, { encoding, signal?, sandboxPolicy? })` — atomically creates a non-existing file (`createIfAbsent`) using `'utf8'` or any supported `NonUtf8Encoding`.
- `setEncodingResolver(resolver)` / `clearEncodingResolver()` — dynamically set or clear the custom callback and invalidate cached encodings.
- `clearCache(target?)` — explicitly invalidate cached encoding state for one target or all targets.

## Configuration

- `sandbox` (`boolean`, default `true`): Enforce `sandboxPolicy` confinement (`EncodingAdaptiveSandboxedFileSystem`) when enabled, or bypass sandbox mutation checks (`EncodingAdaptiveLocalFileSystem`) when `false` (the host still provides `sandboxPolicy`).
- `encodings` (`Record<string, string>`, default `{}`): Glob-to-encoding overrides (e.g. `{ "*.csv": "gbk", "legacy/**": "shift_jis", "legacy/README.txt": "utf8" }`). Later declarations override earlier ones, so `'utf8'` exemptions must be placed after broader patterns. Invalid encoding names log a warning and are skipped.
- `resolveEncoding` (`EncodingResolver`, optional): Custom sync/async callback `(context) => 'utf8' | NonUtf8Encoding | undefined`.
- `cwd` (`string`, optional): Base directory for relative paths.
- `diffBasisMaxBytes` (`number`, default `10 MiB`): Max UTF-8 byte limit per diff basis side for presentation only (`before: null` when exceeded). Does not cap `writeText` encoding detection or preservation.

## Sandbox Compatibility Note

The plugin declares `sandboxPolicy` as a required Cordis dependency (`inject: ['sandboxPolicy']`). When `sandbox: true` (default), `EncodingAdaptiveSandboxedFileSystem extends EncodingAdaptiveLocalFileSystem` and enforces per-call `sandboxPolicy` confinement (`checkedTarget`, synced cleanly from `@deepseek-ai/dsh-fs-sandbox` into `src/upstream/sandbox-fence.ts`) on `createText` and all five mutating `FileSystem` operations before calling `super.*`. When `sandbox: false`, `EncodingAdaptiveLocalFileSystem` is instantiated directly without mutation confinement checks.
