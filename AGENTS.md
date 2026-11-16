# Repository Guidelines

## Project Structure & Module Organization

This package provides encoding-adaptive filesystem operations and search for DeepSeek Harness (`dsh`).

- `src/index.ts`: plugin registration and configuration.
- `src/encoding/`: detection, codecs, caching, and encoding overrides.
- `src/fs/`: local and sandboxed filesystem providers, editing, and locks.
- `src/search/`: encoding-aware grep integration.
- `src/upstream/`: helpers synchronized with upstream implementations.
- `test/`: encoding, filesystem, sandbox, and grep tests.
- `locale/`, `icon.svg`, and `cordis.patch.yml`: translations and plugin assets.
- `lib/`: generated JavaScript and declarations; edit source files instead.

## Build, Test, and Development Commands

Use a Node.js version supported by `package.json` and pnpm >=12.3.4.

- `pnpm install`: install dependencies.
- `pnpm build`: compile TypeScript into `lib/`.
- `pnpm dev`: watch and recompile source changes; this does not launch dsh.
- `pnpm typecheck`: check source and test types.
- `pnpm test`: run the Vitest suite.
- `pnpm test:watch`: run tests interactively.
- `pnpm lint`: run Oxlint.
- `pnpm fmt:check`: check formatting; `pnpm fmt` applies formatting.

## Coding Style & Naming Conventions

Use strict TypeScript with ESM imports, two-space indentation, single quotes, and semicolons. Follow Oxfmt configuration. Use `.js` extensions in relative imports and `import type` for type-only dependencies. Use camelCase for functions and variables, PascalCase for classes and interfaces, and descriptive kebab-case filenames. Include braces around control-flow bodies.

## Testing Guidelines

Place Vitest tests in `test/**/*.test.ts`, using descriptive behavior-based test names. Run a focused suite with `pnpm exec vitest run test/encoding.test.ts`. Tests use the Node environment; no numeric coverage threshold is configured.

For encoding changes, verify exact output bytes, BOM and line-ending preservation, and rejection of lossy writes. Exercise sandbox boundaries and grep behavior when affected. Use temporary fixtures and clean up filesystem resources and plugin contexts.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so existing commit conventions cannot be verified. Use concise, imperative commit subjects.

Pull requests should describe the problem, behavior changes, and validation commands/results. Link relevant issues and explain compatibility or configuration changes.

## Architecture Guardrails

Preserve native UTF-8 behavior and lossless legacy-encoding mutations. Keep sandbox enforcement and atomic-write protections intact. Review upstream-synchronized helpers carefully when updating dependencies.
