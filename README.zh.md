# dsh-fs-encoding-adaptive

[English](./README.md) | **简体中文**

适用于 DeepSeek Harness（`dsh`）的自适应编码 `FileSystem` 提供者、`ctx.fsEncoding` 服务与 `grep` 增强插件。

## 设计原则

本项目的目标是在保留官方 DSH 文件系统行为的同时，扩展对非 UTF-8 文件的读取、写入与检索支持。在这些编码扩展能力之外，其余操作均直接委托给官方公开 API 或继承其实现。

- 未配置用户指定编码时，保留原生行为并补充非 UTF-8 支持。
- 通过配置、解析回调或 `createText` 选定的编码属于明确的用户选择（包括针对已有纯 ASCII 文件的规则）。在下列边界内严格尊重该选择，同时保留官方沙箱、版本校验、原子写入及错误处理保护。
- 已有的非 ASCII 合法 UTF-8 文件与 UTF-8 BOM 文件将继续受保护，不受宽泛编码规则影响，始终走原生 UTF-8 路径。

- **默认 UTF-8 与 UTF-8 BOM 保护**：未配置显式规则时，官方 `LocalFileSystem` 可合法处理的文件（UTF-8、UTF-8 BOM `EF BB BF`、ASCII、新建文件）直接透传至 `super.*` 公开方法。即使配置了编码规则（`resolveEncoding` 回调或 `config.encodings`），包含**非 ASCII 合法 UTF-8 字符或 UTF-8 BOM** 的已有常规文件仍受保护并走原生 UTF-8 路径。流式读取（`streamText`）不做增强，直接继承官方 UTF-8 实现。
- **优先级（`callback > config.encodings > auto-detection`）与统一版本化缓存**：
  - `resolveEncoding` 回调（同步或异步）优先级高于 `config.encodings` glob 规则，后者优先级高于 BOM/`chardet` 自动检测。
  - 普通回调异常或不支持的返回值会记录警告并回退至 `config.encodings` -> 自动检测；取消信号（`AbortSignal` / `FS_ABORTED`）会继续向上抛出 `FS_ABORTED`。一旦选定编码，解码、无损往返或严格编码失败时不会静默切换为其他编码。当未选定编码且旧内容无法检测为受支持的文本时，普通整文件覆盖写入保留原生 UTF-8 覆盖行为。
  - 已解析的编码（包括显式 `'utf8'` 结果）会按 `targetKey` + `FsVersion` 缓存在各文件系统操作（`createText`、`readText`、`writeText`、`editText`、`patchText`）之间，并在 `deleteFile`、`moveFile`、文件版本变化或规则/回调更新时失效。`grep` 独立运行纯 BOM/`chardet` 自动检测，不使用 `encodingCache`、`config.encodings` 与 `resolveEncoding`。
  - 已配置的规则会主动生效于**新建文件**与**可接管的已有文件**（无 UTF-8 BOM 的纯 ASCII 文件，或直接按配置编码解释的非 UTF-8 字节——不会隐式执行 ASCII 到 UTF-16 的转换）。
  - 普通 `moveFile` 保留源文件字节与编码，不会按目标路径规则自动转码。
- **显式文件创建（`ctx.fsEncoding.createText`）**：使用显式 `'utf8' | NonUtf8Encoding` 创建新文件（`createIfAbsent` 语义：若常规文件已存在则抛出 `FS_NOT_OBSERVED`），不自动添加 BOM，并在 UTF-8 与非 UTF-8 路径上均强制执行 `sandboxPolicy`（`checkedTarget`）约束。
- **不访问私有成员的单继承链**：`EncodingAdaptiveSandboxedFileSystem` 继承自 `EncodingAdaptiveLocalFileSystem`（后者继承官方 `LocalFileSystem`），仅委托公开 API，并将与上游同步的辅助逻辑（`sandbox-fence.ts` 与 `atomic-write.ts`）隔离在 `src/upstream/` 下。
- **不替换官方工具的两段式模型引导**：当 `systemPrompt` 挂载时，轻量级且感知可用工具范围的 `tool:fs-encoding-adaptive` 段落会预先告知模型，哪些可见的内置文件系统与检索工具（`read`、`write`、`edit`、`apply_patch`、`str_replace_editor`、`grep`）在基础 UTF-8 工具 Schema 之外支持这 16 种非 UTF-8 编码；通过 `read` 或 `str_replace_editor`（`view`）读取非 UTF-8 文件时，还会附带单文件提示，报告其编码、BOM、换行符及写入安全规则。
- **无损变更安全（Lossless mutation safety）**：
  - 非 UTF-8 读取通过 `stat1 -> readFile -> stat2` 校验将字节内容与官方 `FsVersion` 配对。
  - 低置信度检测结果会拒绝修改操作，除非通过回调或 `config.encodings` 显式锁定编码。
  - 混合换行符（`LF` + `CRLF` / `CR`）会拒绝编辑/补丁操作，以防破坏行尾格式。
  - 每次非 UTF-8 编辑/补丁操作前都会执行全链路往返校验（`encode(restoreEol(normalizeEol(decode(raw)))) === raw`）。
  - 严格写入编码会拒绝无法映射的字符，而不会静默替换为 `?` 占位符。
  - `writeBytesAtomic` 在同一文件系统上暂存临时文件，保留原有 POSIX 文件权限模式，清理已退出 PID 的 `.dsh-enc-tmp-*` 目录，并在替换前再次校验期望的 `FsVersion`。文件创建使用原子化不覆盖的 `link` 操作。

## 检索编码检测

检索功能会先执行官方搜索，再通过字节检查、BOM 检测及 `chardet` 候选编码补充非 UTF-8 结果。该过程不使用文件系统编码规则、解析回调或文件系统编码缓存。

系统会优先检查 UTF-8；对于其他字节序列，插件按 `chardet` 排序依次验证受支持的候选编码，GBK 并非默认兜底编码。自动检测面对过短或存在歧义的内容时可能发生误判：例如 GBK 编码的 `FIND_中文` 可能被识别为 ISO-8859-1（`FIND_ÖÐÎÄ`），导致搜索 `中文` 时漏检。字节往返校验成功只能确认该解释方式可逆，并不代表它一定是作者原本使用的编码。

## 支持的 16 种非 UTF-8 编码

| 编码族   | 配置 / 规范名称                                 | `ripgrep --encoding` 标签                       |
| :------- | :---------------------------------------------- | :---------------------------------------------- |
| UTF-16   | `utf16le`, `utf16be`                            | `utf-16le`, `utf-16be`                          |
| 东亚编码 | `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-kr` | `gbk`, `gb18030`, `big5`, `shift-jis`, `euc-kr` |
| 单字节   | `windows-1250` ~ `windows-1257`, `iso-8859-1`   | `windows-1250` ~ `windows-1257`, `iso-8859-1`   |

## 服务 API（`ctx.fsEncoding`）

随当前活跃的 `FileSystem` 服务同步挂载：

- `version: string` — 当前包版本号。
- `requireActiveFs(): EncodingAdaptiveLocalFileSystem` — 返回当前活跃的文件系统实例（启用沙箱约束时为沙箱子类）；若文件系统未处于活跃状态则抛出 `FS_IO_ERROR`。
- `createText(target, content, { encoding, signal?, sandboxPolicy? })` — 使用 `'utf8'` 或任意受支持的 `NonUtf8Encoding` 原子创建一个尚不存在的文件（`createIfAbsent`）。
- `setEncodingResolver(resolver)` / `clearEncodingResolver()` — 动态设置或清除自定义解析回调，并使已缓存的编码状态失效。
- `clearCache(target?)` — 显式清除单个目标或全部目标的缓存编码状态。

## 配置项

- `sandbox`（`boolean`，默认 `true`）：启用时使用 `sandboxPolicy` 约束文件写入权限（`EncodingAdaptiveSandboxedFileSystem`）；设为 `false` 时绕过沙箱写入检查（`EncodingAdaptiveLocalFileSystem`，宿主仍会提供 `sandboxPolicy`）。
- `encodings`（`Record<string, string>`，默认 `{}`）：按路径 glob 覆盖编码的映射规则（例如 `{ "*.csv": "gbk", "legacy/**": "shift_jis", "legacy/README.txt": "utf8" }`）。后声明的规则优先级更高，因此 `'utf8'` 豁免规则需放在更宽泛的匹配模式之后。无效的编码名称会记录警告并跳过。
- `resolveEncoding`（`EncodingResolver`，可选）：自定义同步/异步解析回调 `(context) => 'utf8' | NonUtf8Encoding | undefined`。
- `cwd`（`string`，可选）：相对路径的基准目录。
- `diffBasisMaxBytes`（`number`，默认 `10 MiB`）：仅用于展示的 diff 基准单侧最大 UTF-8 字节数限制（超出时 `before: null`）。不会限制 `writeText` 的编码检测或保留。

## 沙箱兼容性说明

本插件将 `sandboxPolicy` 声明为必需的 Cordis 依赖（`inject: ['sandboxPolicy']`）。当 `sandbox: true`（默认）时，`EncodingAdaptiveSandboxedFileSystem extends EncodingAdaptiveLocalFileSystem` 会在调用 `super.*` 之前，对 `createText` 以及全部五个修改类 `FileSystem` 操作按次强制执行 `sandboxPolicy` 范围校验（`checkedTarget`，从 `@deepseek-ai/dsh-fs-sandbox` 干净同步至 `src/upstream/sandbox-fence.ts`）。当 `sandbox: false` 时，将直接实例化 `EncodingAdaptiveLocalFileSystem`，不执行写入沙箱约束检查。
