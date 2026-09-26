// ---------------------------------------------------------------------------
// @debuggen/local-service - workspace-local Vitest configuration.
//
// Serves runs rooted in this directory: editor/IDE test integration and a bare
// `vitest` invoked from apps/local-service. The repository-root
// vitest.config.ts is the authoritative project registry; every gate, and this
// workspace's own `test` / `test:integration` scripts
// (`vitest run --root ../.. --project <name>`), run through it instead.
//
// Both projects come from the root's `localServiceProjects` factory with
// `baseDir: ''`, so a run rooted here registers exactly the projects a root run
// does and both roots behave identically:
//
//   local-service              src/**/*.test.ts
//   local-service-integration  test/integration/**/*.test.ts
//
// Both run in `node` with the hermetic environment (`DEBUGGEN_PROVIDER` set to
// `deterministic`, `ANTHROPIC_API_KEY` emptied). The integration project also
// carries its isolation and timeout policy: `pool: 'forks'`,
// `fileParallelism: false`, `isolate: true`, 30 s `testTimeout` and
// `hookTimeout`, and `retry: 0`.
//
// Two rules hold this contract in place:
//   * This file is never added to the root `projects` array; that would
//     register both project names twice, which Vitest rejects.
//   * Neither project name changes: the names are the gate contract, and
//     `pnpm test:integration` runs
//     `vitest run --project local-service-integration`.
// ---------------------------------------------------------------------------
import { defineConfig } from 'vitest/config';
// This file imports the root config, never the reverse: eslint.config.js
// forbids cross-workspace relative imports. The `.ts` extension is spelled out
// because Vite's native config loader cannot resolve an extensionless import.
import { hermeticEnv, localServiceProjects } from '../../vitest.config.ts';

/**
 * Paths neither project collects, relative to this directory as the run root.
 *
 * Declaring `exclude` replaces Vitest's defaults, so `node_modules` and `.git`
 * are repeated first. `test/fixtures/**`, at any depth, holds the sample
 * project and JSON payloads the integration suites consume at runtime: inputs,
 * never specs. `dist/` and `.tsbuild/` hold compiled copies of the suites.
 */
const sharedExclude: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.tsbuild/**',
  'test/fixtures/**',
  '**/test/fixtures/**',
];

/**
 * A container: it collects nothing itself and registers only the factory's two
 * projects, so `--project local-service` and
 * `--project local-service-integration` resolve here as they do at the root.
 *
 * `env` repeats the hermetic record both projects already carry, keeping the
 * provider and credential guarantee visible in this file; inheritance merges it
 * by key, so the value is unchanged. Nothing else is configured here, so IDE
 * and CI runs execute the same options.
 */
export default defineConfig({
  test: {
    env: { ...hermeticEnv },
    projects: localServiceProjects({ baseDir: '', exclude: sharedExclude }),
  },
});
