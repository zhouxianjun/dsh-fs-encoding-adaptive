# Repository Guidelines

## Project Structure

This DeepSeek Harness (`dsh`) plugin provides encoding-adaptive filesystem operations and search. See `README.md` for behavior and configuration.

- `src/index.ts`: registration and configuration.
- `src/encoding/`, `src/fs/`, `src/search/`: codecs/detection, filesystem providers, and grep integration.
- `src/upstream/`: upstream-synchronized helpers; preserve provenance when updating.
- `test/*.test.ts`: Vitest suites.
- `locale/`, `icon.svg`, `cordis.patch.yml`: plugin assets.
- `lib/`: generated JavaScript and declarations; change sources and rebuild.

## Development Commands

Use Node.js matching `package.json` engines and pnpm >=12.3.4.

- `pnpm install`: install dependencies.
- `pnpm build` / `pnpm dev`: compile / watch compilation; neither launches dsh.
- `pnpm typecheck`: check source and test types.
- `pnpm test` / `pnpm test:watch`: run / watch Vitest.
- `pnpm lint`: run Oxlint.
- `pnpm fmt:check` / `pnpm fmt`: check / apply Oxfmt formatting.

## Design & Framework Boundaries

Trace responsibilities and callers before editing; fix root causes, synchronize affected contracts and documentation, and avoid speculative abstractions or compatibility layers. Preserve unrelated changes. Do not bump versions without a release request.

Read-only inspection of upstream documentation, source, types, tests, and Git history is allowed. Do not modify the upstream checkout or couple this package to its internal filesystem paths. Prefer public APIs/types and existing dependencies.

Keep state scoped to its plugin/session. Release owned timers, watchers, and subprocesses through documented lifecycle hooks; avoid duplicating framework-managed cleanup.

## Upstream Synchronization

This plugin extends upstream UTF-8 behavior. Periodically review upstream changes; during dependency upgrades or filesystem, sandbox, or search changes, inspect documentation, source, types, tests, and history as needed for the affected contracts. Compare against the dependency version actually used and distinguish newer upstream changes.

Compare upstream behavior with our overrides and `src/upstream/` helpers, including errors, version checks, atomic writes, platform handling, and lifecycle behavior. Adapt relevant fixes while retaining encoding guarantees. Keep necessary synchronized helpers isolated in `src/upstream/`; record their upstream package/version or commit, source path, and intentional deviations. Do not copy unrelated framework code.

Report the compared revisions, changes adopted or deferred with reasons, and targeted validation. Verify affected UTF-8 parity and legacy-encoding invariants; do not add tests merely to duplicate upstream coverage.

## Coding Conventions

Use strict TypeScript, ESM, two-space indentation, single quotes, and semicolons. Use `.js` relative imports and `import type`. Prefer camelCase functions/variables, PascalCase types/classes, and kebab-case filenames. Use control-flow braces. Validate external inputs at boundaries; avoid redundant internal checks. Comments explain non-obvious constraints, not code history.

## LLM-Facing Content

For prompts, tool descriptions, injected context, and model-visible output, state desired behavior, valid inputs, conditions, and next steps positively. Preserve necessary prohibitions and exact API names/error codes. Describe failures truthfully with location and cause when known. Offer feasible corrections when known; otherwise state limitations or missing information. Never invent advice or present failure as success. Trace actual assembly and consumers when changing these contracts.

## Safety & Testing

Preserve native UTF-8 behavior, byte-exact legacy encoding round-trips, BOM/EOL preservation, sandbox confinement, and atomic-write/version protections.

Add tests only for concrete regression risks or core invariants affected by the change. Assert observable behavior, especially byte preservation, lossy-write rejection, sandbox boundaries, and grep correctness where relevant. Do not duplicate tests of unchanged framework internals; test integration contracts and regression risks at our framework boundary when affected. Avoid trivial mappings, exact-prose assertions, private call sequences, excessive mocks, and redundant coverage. Clean up fixtures and plugin contexts. Test counts and coverage percentages are not completion criteria.

Run focused tests, e.g. `pnpm exec vitest run test/encoding.test.ts`, plus checks appropriate to the change. Documentation-only changes need content and diff review. Report actual validation and unverified behavior separately.

## Commits & Pull Requests

Use concise imperative subjects. PRs describe the problem, resulting behavior, validation, and compatibility/configuration changes; link relevant issues. Review the complete task diff before delivery.
