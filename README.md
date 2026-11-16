# dsh-fs-encoding-adaptive

Encoding-adaptive `FileSystem` provider and `grep` enhancement plugin for DeepSeek Harness (`dsh`).

## Design Principles

- **Native UTF-8 & UTF-8 BOM passthrough**: Files valid under official `LocalFileSystem` (UTF-8, UTF-8 BOM `EF BB BF`, ASCII, new creates) pass directly through `super.*` public methods. Streaming (`streamText`) is not enhanced and inherits the official UTF-8 implementation directly (so default `read` tool streaming at `>= 10 MiB` follows official behavior and rejects non-UTF-8 files with `FS_NOT_TEXT`).
- **Exception-driven legacy fallback & encoding-preserving overwrites**: `readText`, `editText`, `patchText`, and `moveFile` delegate to `super.*` first and run non-UTF-8 detection only when `super.*` raises `FS_NOT_TEXT`. `writeText` delegates new files directly to official `writeText`, and for existing regular files reads the prior bytes regardless of `diffBasisMaxBytes`: valid UTF-8/UTF-8 BOM/ASCII, unreadable, binary, or unsupported files fall back to official `writeText`, while reliably detected non-UTF-8 files preserve their encoding, BOM, and line endings inside an `AsyncLocalStorage`-backed reentrant lock (`withEncodingLock`).
- **Single inheritance chain without private-member access**: `EncodingAdaptiveSandboxedFileSystem` extends `EncodingAdaptiveLocalFileSystem` (which extends official `LocalFileSystem`), delegating only public APIs and isolating upstream-synced helpers (`sandbox-fence.ts` and `atomic-write.ts`) under `src/upstream/`.
- **Lossless mutation safety**:
  - Atomic `stat1 -> readFile -> stat2` pairing using the provider's official `FsVersion`.
  - Low-confidence detections reject mutations unless explicitly pinned via `config.encodings`.
  - Mixed line endings (`LF` + `CRLF` / `CR`) reject edits/patches to prevent EOL corruption.
  - Full-pipeline round-trip verification (`encode(restoreEol(normalizeEol(decode(raw)))) === raw`) runs before every non-UTF-8 edit/patch.
  - Strict write encoding rejects unmappable characters instead of emitting `?` placeholders.
  - `writeBytesAtomic` stages on the same filesystem, preserves POSIX file mode, cleans dead-PID `.dsh-enc-tmp-*` directories, and re-checks official `FsVersion` immediately prior to `rename`.

## Supported 16 Non-UTF-8 Encodings

| Family      | Config / Canonical Names                        | `ripgrep --encoding` Label                      |
| :---------- | :---------------------------------------------- | :---------------------------------------------- |
| UTF-16      | `utf16le`, `utf16be`                            | `utf-16le`, `utf-16be`                          |
| East Asian  | `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-kr` | `gbk`, `gb18030`, `big5`, `shift-jis`, `euc-kr` |
| Single-byte | `windows-1250` ~ `windows-1257`, `iso-8859-1`   | `windows-1250` ~ `windows-1257`, `iso-8859-1`   |

## Configuration

- `sandbox` (`boolean`, default `true`): Uses `EncodingAdaptiveSandboxedFileSystem` (`sandboxPolicy` injected) when enabled, or `EncodingAdaptiveLocalFileSystem` when `false`.
- `encodings` (`Record<string, string>`, default `{}`): Glob-to-encoding overrides (e.g. `{ "*.csv": "gbk", "legacy/**": "shift_jis" }`).
- `cwd` (`string`, optional): Base directory for relative paths.
- `diffBasisMaxBytes` (`number`, default `10 MiB`): Max UTF-8 byte limit per diff basis side for presentation only (`before: null` when exceeded). Does not cap `writeText` encoding detection or preservation.

## Sandbox Compatibility Note

`EncodingAdaptiveSandboxedFileSystem extends EncodingAdaptiveLocalFileSystem` and enforces per-call `sandboxPolicy` confinement (`checkedTarget`, synced cleanly from `@deepseek-ai/dsh-fs-sandbox` into `src/upstream/sandbox-fence.ts`) on all five mutating operations before calling `super.*`. If `sandboxPolicy` is not mounted within 5 seconds, the plugin logs a warning.
