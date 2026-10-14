# 1. Executive Summary

## 1.1 Project Overview

Custom Debugging Generator is a local developer tool. It turns a plain-English question about a React, Next.js and PostgreSQL project into a purpose-built Chrome DevTools panel. The panel draws on reversible instrumentation and on correlated browser, server and database traces, and every runtime item links to its source in VS Code. The once-empty repository holds the full pnpm monorepo: two extensions, a local service, eight shared packages, the "Lumen Supply" demo with three seeded defects, tests, CI and documentation.

## 1.2 Completion Status

```mermaid
%%{init: {'theme':'base','themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieOuterStrokeColor':'#B23AF2','pieSectionTextColor':'#B23AF2','pieTitleTextSize':'16px'}}}%%
pie showData title 98.0% complete
    "Completed Work" : 2776
    "Remaining Work" : 56
```

| Metric | Value |
|---|---|
| Total Hours | 2,832 |
| Completed Hours (AI + Manual) | 2,776 (AI 2,776 + Manual 0) |
| Remaining Hours | 56 |
| Percent Complete | **98.0%** (2,776 ÷ 2,832) |

## 1.3 Key Accomplishments

- ✅ All four acceptance tests pass on the real stack: Slow Button, React Rendering, Cleanup and Generalization (`tests/e2e/`, 37 of 37).
- ✅ One click resolves to one trace correlated by `traceparent`: interaction → fetch → route handler → service function → `pg` query.
- ✅ Instrumentation is reversible: a crash-safe journal, hash-checked restore and preserved conflicts. The demo source is byte-identical after every session.
- ✅ Thirteen visualization components render validated panel specs. The render and latency panels share only metric cards and source links.
- ✅ The local access boundary is in place: role-bound credentials, one-time Chrome pairing, refusal of web origins and token rotation.
- ✅ `pnpm verify` is green (24,980 Vitest tests, 89.3% statement coverage), as are the extension-host, browser, end-to-end and fresh-clone tiers.
- ✅ Product source holds no demo knowledge: the AST guard finds 0 violations, and an unrelated fixture app reaches a generated panel.
- ✅ README, ARCHITECTURE, DEMO and SECURITY documents are delivered, and the DEMO.md commands run as written.

## 1.4 Critical Unresolved Issues

No test or acceptance criterion fails. 19 of 20 AAP requirement areas are met, and 1 is partial: version-control discipline (§0.8.5). **23 residual items remain open**. Their ETAs sum to the 56 hours in Section 2.2.

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| Release decisions (3): accept or restructure the history's multi-slice commits (Section 5.2 D1); confirm the security reporting address; confirm the `prisma@7.10.0` provenance exception | Blocks publishing sign-off, not function | Repository owner | 5 h |
| Accepted behaviour caveats (6): untargeted questions name `CheckoutForm`; a stale conflict closes only at the next service start; readiness falls back to the previous document's status (including a 256-tab eviction edge); a SIGKILLed CLI credential lapses after 20 s; free-text redaction limits | Minor correctness and privacy edges. Each is documented | Service engineer | 14 h |
| Never exercised at runtime (5): the panel inside a real DevTools frame and a real VS Code window; the live Anthropic provider; GitHub-hosted CI; macOS and Windows; a clean-machine install from the README | Unproven on production paths | QA / DevOps | 28 h |
| Performance and operations (3): each `GET /sessions/:id` replays about 40 frames; burst ingest sheds load; an OTel start/end warning appears per capture | Load and noise only | Service engineer | 6 h |
| UI polish (6): duplicate Copy-path names, DiffView name, landmark nesting, FollowUp focus, preload rows keyed by signal, SessionSummary wording | Cosmetic and accessibility | Frontend engineer | 3 h |

## 1.5 Access Issues

| System/Resource | Type of Access | Issue Description | Resolution Status | Owner |
|---|---|---|---|---|
| GitHub Actions | CI runners | The workflow `.github/workflows/ci.yml` has not yet run on hosted runners. Its commands were executed locally | Pending first push | DevOps |
| GitHub repository | Security advisories | The repository is private, so outsiders cannot use GitHub private vulnerability reporting. `docs/SECURITY.md` §11 names the maintainer's email | Awaiting owner confirmation | Repository owner |
| Local clone remote | Git credentials | The `origin` URL in `.git/config` embeds an access token. CI clones fresh and never caches `.git` | Rotate the token and use a credential helper | Repository owner |
| Anthropic API | Model provider | A key is available, but every automated run uses the deterministic provider. `DEBUGGEN_MODEL` must be chosen explicitly | Validation pending (live-provider task, Section 2.2) | Service engineer |

## 1.6 Recommended Next Steps

1. [High] Push to GitHub and triage the first `verify` and `e2e` workflow runs.
2. [High] Validate the three demonstrated questions and the fixture app against the live Anthropic provider, with an explicit `DEBUGGEN_MODEL`.
3. [High] Run manual QA in real Chrome DevTools and VS Code: Elements selection, the picker, themes, MV3 reconnect, F5 and VSIX install.
4. [High] Record the commit-history exception and sign off divergences D1–D8 (Section 5.2).
5. [Medium] Add a conflict-resolution path, and decide how readiness identifies the current document.

# 2. Project Hours Breakdown

## 2.1 Completed Work Detail

| Component | Hours | Description |
|---|---|---|
| Workspace foundation and root tooling | 24 | pnpm 12.4.2 workspace with 12 packages and a tracked lockfile; TypeScript 6.0.3 project references; strict `tsconfig.base.json`; flat ESLint with layering rules; Prettier; Vitest and Playwright projects; `.env.example`; Compose PostgreSQL 18.6; `.vscode/*` |
| CI and supply-chain policy | 12 | SHA-pinned `verify` and `e2e` jobs with a PostgreSQL service; `pnpm audit` and `check:advisories` steps; pnpm release-age and trust policy |
| Guard scripts and CLIs | 40 | AST-aware `check-no-hardcoding.mjs` with a policy and allowlist; `check-secrets.mjs` (entropy, UTF-16, archives); `check-no-residual-instrumentation.mjs`; `copy-agent.mjs`; `dev-instrumented.mjs` |
| `packages/shared` | 24 | Ids, `Result`, POSIX path containment, the `SourceLocation` schema, logger, and no-follow `safe-fs` with ownership and mode checks |
| `packages/protocol` | 60 | Zod envelope; schemas for all 30 protocol messages (WebSocket and HTTP); typed HTTP route table; `SessionRecord`; `AnalysisResult`; a reconnecting WebSocket client and an HTTP client |
| `packages/telemetry` | 240 | Event schema, redaction layer and HMAC request keys, correlator, aggregates. MAIN-world browser agent: bippy commits, fiber diff, fetch/XHR `traceparent`, continuation lineage, picker. Node preload: OTel, Prisma and `pg` instrumentation, exporter, disable control |
| `packages/instrumentation` | 150 | Authoring and normalized plan schemas; registry and six adapters; installer with delta rollback; ts-morph function-timing patcher; crash-safe journal; conflict detection and chain-aware cleanup |
| `packages/panel-schema` | 40 | `PanelSpecInput`/`PanelSpec` DSL, deterministic `normalizePanel`, node catalog, syntactic and semantic validation, JSON Schema export |
| `packages/panel-renderer` | 240 | Token source with generated CSS for 3 themes and contrast tests; 14 primitives; 6 layout primitives; 13 visualization components; `PanelHost`, registry and `useQuery` |
| `packages/code-analysis` | 120 | ts-morph indexer, 8 extractors, code graph queries (`findByName`, `whoCalls`, `routeForUrl`, `pathBetween` and others), route map, cache, and source-map resolver |
| `packages/model-provider` | 80 | `ModelProvider` interface, Anthropic structured output, a rules-based deterministic provider, a repair loop with at most 2 retries, versioned prompt loader, outbound redaction guard |
| `apps/local-service` | 540 | hono and ws server; auth, pairing and origin policy; `node:sqlite` store with migrations and retention; session state machine; six-stage pipeline with follow-ups and 12 versioned prompts; instrumentation, readiness and watcher; ingest and correlation; panels and data; source open; dev-server launcher; cleanup |
| `apps/vscode-extension` | 160 | Manifest with 12 commands and 5 settings; session webview (React); Sessions tree; embedded service process manager; URI handler; `open-location`; self-contained VSIX build |
| `apps/chrome-extension` | 166 | MV3 manifest with MAIN and ISOLATED content scripts; service worker (WebSocket bridge, tab registry, agent control, pairing, keepalive); DevTools page; panel app and components |
| `apps/demo-app` (Lumen Supply) | 140 | Next.js 16 storefront pages, 11 route handlers, 9 services, Prisma 7 with the `pg` adapter, migration, a realistic seed, and three seeded defects |
| Integration, extension-host, browser and e2e suites | 210 | 18 integration suites, 5 VS Code host suites, 6 browser specs, 7 e2e specs, and a clean-clone check |
| Unit and component test suites | 300 | 306 Vitest files across 13 projects (24,336 tests), including guard-script tests |
| Documentation | 30 | `README.md` with screenshots, `docs/ARCHITECTURE.md` (Mermaid), `docs/DEMO.md`, `docs/SECURITY.md` |
| Cross-cutting QA and hardening | 200 | Security, accessibility, performance, contract and runtime verification across all surfaces, carried to a fully green gate |
| **Total** | **2,776** | |

## 2.2 Remaining Work Detail

| Category | Hours | Priority |
|---|---|---|
| Commit-history exception and divergence sign-off (D1, D3, D4, D8) | 3 | High |
| First GitHub Actions run of `verify` and `e2e` jobs, and triage | 4 | High |
| Live Anthropic provider validation (model choice, three demo questions and the fixture app, repair and fallback, outbound redaction) | 8 | High |
| Manual QA in real Chrome DevTools and real VS Code (Elements `$0` selection, picker, themes, MV3 idle reconnect, F5, VSIX install, source jump) | 6 | High |
| Security reporting channel and `prisma@7.10.0` provenance confirmation (D2) | 2 | Medium |
| Conflict-resolution path: re-run cleanup on re-end, or add a Resolve action (D7) | 4 | Medium |
| Readiness document identity: a `webNavigation` permission or a document id on `tab.navigated` (D5) | 4 | Medium |
| Untargeted-question naming decision (D6) | 2 | Medium |
| macOS and Windows validation (launcher, process supervision, extension-host tests) | 8 | Medium |
| Redaction hardening for documented free-text limits | 4 | Medium |
| Clean-machine install rehearsal from README (VSIX, unpacked extension, service, demo) | 2 | Medium |
| Replay and ingest performance tuning (`GET /sessions/:id` replay, burst ingest) | 6 | Low |
| Accessibility and wording polish residuals | 3 | Low |
| **Total** | **56** | |

# 3. Test Results

All figures below come from one run of `pnpm verify`, `xvfb-run -a pnpm test:vscode`, `pnpm test:browser` and `pnpm test:e2e` on the delivered branch, using the deterministic provider. `pnpm verify` rebuilds every workspace first. All four commands exited 0. The Vitest totals are 324 files and 24,988 tests: 24,980 passed, 8 skipped and 0 failed. The 8 skips are permission cases that cannot run when the host user is root. Overall coverage is 89.3% statements, 83.21% branches, 93.96% functions and 89.28% lines.

| Area / Category | Framework | Tests | Passed | Failed | Coverage (stmts) | What This Proves |
|---|---|---|---|---|---|---|
| Shared contracts, schemas and repository guards (`packages/{shared,protocol,panel-schema}`, `scripts/*.test.mjs`) | Vitest 5.0.1 | 4,508 | 4,505 (3 skipped) | 0 | 96.1% / 98.4% / 96.3% / 90.8% | Every cross-process message, source location and panel spec parses, normalizes and rejects malformed input; the no-hardcoding, secrets and residual guards catch planted cheats |
| Telemetry capture, redaction and correlation (`packages/telemetry`) | Vitest | 3,678 | 3,678 | 0 | 89.7% | Secrets are redacted before storage; timestamps from both tiers share one epoch-ms clock; traces order parent-first with async continuation lineage; React 19 commits are traversed through bippy |
| Code analysis and model boundary (`packages/{code-analysis,model-provider}`) | Vitest | 2,977 | 2,975 (2 skipped) | 0 | 90.2% / 93.9% | The code graph finds components, handlers, routes and database calls; structured output is repaired at most twice and then rejected; deterministic output does not change with question wording |
| Instrumentation and reversibility (`packages/instrumentation`) | Vitest | 1,939 | 1,938 (1 skipped) | 0 | 92.2% | A patched function body runs exactly once; fresh-process failure injection at every write boundary still restores byte-identical files; edited files are never overwritten |
| Panel renderer and design tokens (`packages/panel-renderer`) | Vitest + happy-dom | 2,097 | 2,097 | 0 | 95.5% | Every catalog node type has a component with empty, loading and error states; the committed token CSS matches its source; all three themes meet WCAG contrast |
| Local service, unit and in-process integration (`apps/local-service`, 18 integration suites) | Vitest | 6,819 | 6,817 (2 skipped) | 0 | 90.0% | Session lifecycle, auth, pairing and origin rules, ingest attribution, both follow-up paths, panel fallback, paged panel data and conflict cleanup all hold against the real HTTP and WebSocket service |
| Editor and browser extensions, unit (`apps/chrome-extension`, VS Code host and webview) | Vitest | 2,970 | 2,970 | 0 | 87.2% / 70.1% | Bridge filtering, tab registry, reconnect policy, pairing, and webview state and message validation behave as specified |
| Runtime tiers: VS Code host (5 suites), browser (6 specs), end to end (7 specs) | @vscode/test-cli on VS Code 1.139, Playwright 1.63 on Chromium 153 | 239 (149 + 53 + 37) | 239 | 0 | — | The packaged VSIX's embedded service answers; the unpacked MV3 extension pairs, captures and renders; all four AAP acceptance tests pass on the full stack with PostgreSQL, and the demo tree is clean afterwards |

**Not Covered** — these capabilities are delivered but no automated test exercises them. Test them before release:

- **DevTools-embedded panel.** The browser suite opens the panel as an extension page with a `chrome.devtools` stub. `inspectedWindow.eval("$0")`, `panels.elements.onSelectionChanged`, `network.onNavigated` and live theme changes need a manual pass in real DevTools.
- **Live Anthropic provider.** It is exercised only through a mocked transport and the provider-unavailable path. Structured output, repair behaviour and outbound redaction against a real model are unproven.
- **Real VS Code window.** Host suites run headless under xvfb. F5 "Run Extension", webview rendering inside VS Code and the `vscode://` operating-system prompt have not been driven interactively.
- **GitHub-hosted CI.** Every workflow command ran locally; the workflow has not run on hosted runners.
- **macOS and Windows paths.** Launcher `cmd.exe`/PowerShell and `lsof`/`ps` ownership lookups, `taskkill` escalation, and the VS Code test path limits are unit-tested only.
- **Heavy and rare runtime paths.** A fallback panel produced by a live capture, captures above 250,000 events, MV3 idle eviction with the heartbeat, and store migration 7 over live rows are covered by unit or integration tests only.
- **Demo storefront internals.** `apps/demo-app` has no unit-test project. Its behaviour is exercised only through the e2e specs, including `cart-line-ceiling.spec.ts`.

# 4. Runtime Validation & UI Verification

Each flow below was driven against running processes: the local service, the Lumen Supply dev server with the Node preload, PostgreSQL 18.6, the unpacked Chrome extension on Chromium 153, and the extension host on VS Code 1.139.

- ✅ **Service start-up and access boundary.** `GET /health` returns `{"version":"0.1.0","protocolVersion":"1.0.0","pairingAvailable":false}`. A web `Origin` gets 403; unauthenticated `GET /sessions` and `POST /pair/start` get 401; the editor bearer from `$DEBUGGEN_HOME/auth.json` gets 200. The state directory is created `0700` and its files `0600`. On shutdown the store flushes its write-ahead log and closes cleanly.
- ✅ **Demo storefront.** `/`, `/cart`, `/checkout`, `/orders`, `/dashboard`, `/api/products` and `/api/inventory/summary` all return 200 from the seeded database. Placing an order is visibly slow (defect 1).
- ✅ **Acceptance 1: slow button** (`demo-slow-interaction.spec.ts`, 10 of 10). Progress reads "Found CheckoutButton → Traced event handler → Found /api/checkout → Found database dependency → Ready to capture". A single trace spans the interaction, the fetch with `traceparent`, `http.server`, the route handler, `placeOrder`, `reserveStock` and `pg.query`. The panel contains a timeline, flame, waterfall, query table and per-tier metric cards. The SQL row opens `inventory.service.ts` at the `pool.query` call site.
- ✅ **Acceptance 2: React rendering and duplicate requests** (10 and 6 specs). The render panel attributes `ProductCard` renders to the `ShippingEtaProvider` context change, and its node set overlaps the latency panel only in `metricCards` and `sourceLink`. The duplicate panel groups identical `/api/recommendations` requests from two initiating rails.
- ✅ **Acceptance 3: cleanup** (`cleanup.spec.ts`, `cleanup-conflict` integration). Every touched file is byte-identical after `session.end`, `git status --porcelain apps/demo-app` is empty, 0 `__DEBUGGEN__` markers remain, and the demo keeps serving. An edited file is kept as a conflict and never overwritten.
- ✅ **Acceptance 4: generalization** (`generalization.spec.ts`, 6 of 6). A session on `tests/fixtures/sample-next-app` reaches `generated` with a trace and a panel.
- ✅ **Chrome extension** (browser tier, 53 of 53). The service worker connects and pairs, the tab binds, the agent is present before React loads, a click yields interaction, render and fetch events on one `traceId`, every catalog node renders in the panel, and `SourceLink` emits `source.open`. The panel was also checked at 375, 768, 1280 and 1920 px in dark, light and high-contrast themes.
- ✅ **VS Code extension** (host tier, 149 of 149). It activates and registers its commands, `open-location` works, the URI handler rejects out-of-workspace paths, and the packaged VSIX's embedded service answers `/health`.
- ⚠ **Live model provider.** Only the deterministic provider and the provider-unavailable message were exercised; no request was sent to Anthropic.
- ⚠ **Production hosts.** Three hosts were never exercised: the panel embedded in a real DevTools window (`$0` selection), an interactive VS Code window, and GitHub-hosted CI. No run was made on macOS or Windows.

# 5. Compliance & Quality Review

## 5.1 Compliance Matrix

| # | AAP Deliverable | Benchmark | Status | Progress | Evidence |
|---|---|---|---|---|---|
| 1 | End-to-end workflow and progress wording (§0.1.1, §0.7.3) | Real pipeline, no faked output | ✅ Pass | ██████████ 100% | `demo-slow-interaction.spec.ts`; `sessions/progress.ts`. The untargeted-question wording differs (D6) |
| 2 | Four components, adapter architecture, six adapters (§0.2.2–§0.2.3) | Plug-in adapters with no orchestrator change | ✅ Pass | ██████████ 100% | `packages/instrumentation/src/registry.ts`; VS Code, MV3 and service builds |
| 3 | Reversible instrumentation (§0.5.1) | Hash-recorded, crash-safe, never overwrites | ✅ Pass | ██████████ 100% | `patch/patcher.ts`, `cleanup.ts`, `cleanup.spec.ts`. Conflict lifecycle per D7 |
| 4 | Staged AI, schemas, repair, fallback, versioned prompts (§0.5.3) | Validated before any effect | ✅ Pass | █████████░ 95% | `model-provider/src/structured.ts`; `prompts/manifest.json` (v001 and v002); `panel-fallback` suite. Live provider not yet exercised |
| 5 | Component library, catalog ↔ registry, tokens and themes (§0.6) | Tokens only, WCAG contrast | ✅ Pass | ██████████ 100% | 13 components; `tokens.test.ts`; `registry.test.ts` |
| 6 | Trace correlation and source resolution (§0.4.2) | W3C trace context, project-relative locations | ✅ Pass | ██████████ 100% | `correlator.ts`, `continuation.ts`, `source/open.ts`, `uri-handler.ts` |
| 7 | Demo app, seeded defects, no hardcoding (§0.8.2, §0.5.4) | Defects discoverable only through the pipeline | ✅ Pass | ██████████ 100% | `check:no-hardcoding` reports 0 violations; `generalization.spec.ts` passes 6 of 6 |
| 8 | Persistent sessions, reopen, retention (§0.4.2) | Survives restart; 30-day purge | ✅ Pass | ██████████ 100% | `store/*`, `sessions/reopen.ts`, `retention.test.ts` |
| 9 | Telemetry privacy and redaction (§0.5.2) | Redact before store, tail and egress | ✅ Pass | █████████░ 95% | `telemetry/src/redaction/*`, `redact-guard.ts`. Free-text limits are documented in `docs/SECURITY.md` §3.4 |
| 10 | Access boundary and graceful failure (§0.5.5–§0.5.6) | Authenticate every client, refuse web origins | ✅ Pass | █████████░ 95% | `server/auth.ts`, `auth.test.ts`. Credential and readiness caveats per D4 and D5 |
| 11 | Tests, tooling and quality gates (§0.8.3, §0.8.5) | `pnpm verify` plus three runtime tiers green | ✅ Pass | █████████░ 95% | Section 3. Not yet run on hosted CI |
| 12 | Documentation and version-control discipline (§0.8.5) | Four documents; logical, conventional commits | ⚠ Partial | ████████░░ 85% | All four documents delivered; commit history per D1 |

## 5.2 AAP & Rule Divergences and Gaps

No user rules were supplied (AAP §0.10). Every divergence below departs from the AAP; none was requested by a human.

| # | What the AAP/Rule Required | What Was Delivered Instead | Why It Diverged | Impact | Remediation |
|---|---|---|---|---|---|
| D1 | §0.8.5: logical conventional commits, no mega-commit | 71 of 75 commits are conventional; 4 subjects are not, and 6 commits span 102–471 files | Late hardening was integrated as squashed commits; pushed history was not rewritten | Coarse review and bisect; no functional effect | Accept and record, or split before publishing |
| D2 | §0.3.2: `next` 16.3.5; no pnpm policy keys | `next` 16.3.6; release-age and trust policy with 4 reviewed exceptions; `check:advisories` | A critical Next.js advisory was published after the AAP | Security improved; one extra CI step | Confirm the `prisma@7.10.0` provenance exception |
| D3 | §0.2.3/§0.4.2: fixed envelope, ingest body, tables and bridge relay | Optional `tabId` and `x-debuggen-tab` header, extra ingest identity fields, `bindings.bound_by`, a private bridge channel | Needed to enforce per-tab authorization and correct attribution | Backward compatible; documented | Accept |
| D4 | §0.5.6: the server-agent credential expires when its process exits | A SIGKILLed CLI's credential lapses 20 s after its last preload disconnect | A killed process cannot run exit code | Short same-user window | Accept |
| D5 | §0.7.1 Group 2: readiness needs `agent.ready` from the current document | A document that never reports within 1.5 s leaves the previous report in force | `tabs.onUpdated` carries no document id; `webNavigation` is not among the AAP permissions | Rare false-ready | Decide on adding `webNavigation` |
| D6 | §0.1.2: progress "Found CheckoutButton / Traced event handler" | An untargeted question names `CheckoutForm` and its `onSubmit` | §0.5.4 forbids question-word matching; the graph cannot single out the button | Wording only | Accept, or require a selection |
| D7 | §0.5.1: conflict retained and re-reported | Conflicts are re-judged; a stale conflict closes at the next start; pre-v6 stored sessions cannot re-instrument | Restore-on-match rule; `end` is idempotent; older records lack a root proof | A restart is needed after undoing an edit | Add a resolve action |
| D8 | Other AAP specifics (file names, settings, token set, §0.6.4 literals) | `vite.config.mts`; a fifth setting `debuggen.model`; 2 extra kind tokens; documented literal exceptions; progress capped at 1,000 rows; demo stock holds | Module-format, configuration and design constraints | None functional | Accept or amend the AAP inventory |

**D1 — Commit discipline.** Most of the history follows the AAP's slice-by-slice conventional pattern, from `5a482a2 chore(setup)` onward. The late hardening work landed as six large integration commits of 102 to 471 files each. `c31cdfb` touches 425 files (+220,143/−22,359) and `da6e529` touches 461. These two, together with `6786bb2` (111 files) and `8747137` (102 files), have non-conventional subjects. `4e17a56` (471 files) and `a146020` (189 files) are conventional but each spans several slices. The history was not rewritten because it had already been pushed. Nothing functional depends on this, but review and `git bisect` of late changes are coarse. The owner must accept and record the exception, or split these commits before the branch is published.

**D2 — Dependency pin and supply-chain policy.** AAP §0.3.2 pins `next` 16.3.5. The demo and fixture use 16.3.6 (`apps/demo-app/package.json:25`) because a critical Next.js advisory, GHSA-vcvr-r3jv-pc5j, was published after the AAP was written. `pnpm-workspace.yaml` also adds a 24-hour minimum release age, a trust policy, and `no-downgrade` with four reviewed exceptions: rollup, chokidar, prisma and semver. `prisma@7.10.0` is excluded from the provenance check because it was published without trusted publishing, although its tarball review was clean. The `check:advisories` root script and CI audit steps are additions to the AAP's script list. The owner should confirm the Prisma exception.

**D3 — Protocol and storage additions.** The AAP fixes the envelope as `{ id, type, sessionId?, ts, payload }`, fixes the ingest body as `{ projectRoot, events }`, and describes the bridge as a `window.postMessage` relay. The code adds an optional acting `tabId` and an `x-debuggen-tab` header (`packages/protocol/src/envelope.ts`), because one worker credential carries every tab while §0.5.6 authorizes per tab. Optional ingest identity fields stop retried Node batches from being credited to the wrong capture. A `bound_by` column, rebuilt by store migration 7, lets colliding tab ids from two browsers coexist. A private bridge handshake channel stops page scripts from impersonating the agent. Every addition is optional, so older clients still work. Accepting them is recommended.

**D4 — Server-agent credential lifetime.** §0.5.6 says the server-agent credential "expires when the launched process exits". For dev servers the service launches, that holds. The CLI path (`scripts/dev-instrumented.mjs`) also releases its credential on a normal exit or a signal. A CLI killed with SIGKILL cannot run exit code, however. Its credential then lapses through supervision, 20 seconds after the last preload connection closes, or at the lease's end if a copy of the token keeps a socket open. Only a process running as the same user can hold such a copy, so exposure is bounded. The owner should confirm that this bounded fallback is acceptable.

**D5 — Readiness for the current document.** Readiness requires `agent.ready` from the bound tab's current document (§0.7.1 Group 2). `tab.navigated` carries only `{ tabId, url }`, because the service worker derives navigations from `chrome.tabs.onUpdated`, which has no document id. `chrome.webNavigation` would supply one but is not among the AAP's permissions (storage, alarms, tabs). As a result, a replacement document that never reports within the 1.5-second settle window leaves the previous document's report in force; a Chrome error page shown while the dev server is down is one example. Capture start re-evaluates readiness (`apps/local-service/src/instrumentation/readiness.ts`). The owner should decide whether to add the permission.

**D6 — Untargeted question naming.** The AAP's progress example for "Why is this button slow?" shows "Found CheckoutButton" and "Traced event handler". When the developer selects the element first, which is the flow `docs/DEMO.md` scripts, the rows match exactly. Without a selection, Stage 2 receives only the structured understanding: category, routes and signals. `CheckoutForm` renders about fifteen controls, and nothing in the code graph singles out the button. Matching words from the question is forbidden by §0.5.4. The untargeted flow therefore names `CheckoutForm` and traces its `onSubmit`, which is the handler that really issues `POST /api/checkout`. Analysis and panels are unaffected. Accept this as designed, or require a target selection for interaction questions.

**D7 — Conflict lifecycle.** §0.5.1's reconciliation table says a conflict is "retained, backup kept, re-reported". Each pass instead re-judges a conflict record, following §0.5.1's own restore-on-match paragraph: it is restored if the file is back at `instrumentedHash`, closed if the file is back at `originalHash`, and retained only while the file still diverges. Ending an already-ended session does not re-run cleanup, because `SessionManager.end` is idempotent, so a stale conflict closes only at the next service start. No "Resolve conflict" action exists. Sessions stored before store schema v6 lack a root proof: they reopen read-only but cannot index or instrument. Adding a resolve action is scheduled in Section 2.2.

**D8 — Remaining specifics.** `apps/vscode-extension/vite.config.mts` replaces the planned `vite.config.ts` because the package must stay CommonJS for VS Code. A fifth setting, `debuggen.model`, carries the model id that §0.5.3 forbids hardcoding. The token set adds `kindService` and `kindExternal` span colours. §0.6.4's literal-value rule has two documented exceptions: the in-page picker overlay, which cannot import the design system, and `100%`/`calc()` webview sizing. Progress history is capped at 1,000 rows per session; `reserveStock` writes stock holds, so re-seed after long demo series; normaliser-failure logs record shape rather than model prose; the Anthropic provider sends only temperature 1. None affects correctness. The owner should accept these or amend the AAP inventory.

# 6. Risk Assessment

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| The real model may emit plans or panel specs the deterministic provider never does, which would push sessions into the fallback view or into repair failures | Technical | Medium | Medium | Output is schema-validated with at most 2 repairs, then falls back deterministically. Validate the three demo questions against the live provider (Section 2.2) | Open |
| Very large modules — `dev-server/launcher.ts` 10,630 lines, `background/service-worker.ts` 7,066, `instrumentation/service.ts` 6,730, `main.ts` 5,494, `server/auth.ts` 5,111 — slow future change | Technical | Medium | High | High coverage (90%+ on these packages) protects refactors. Split along existing seams after release | Accepted |
| Free-text secrets in the documented edge forms (form-encoded text outside a URL, glued labels, values with spaces) survive redaction and could reach the model provider | Security | Medium | Low | The redactor runs at ingest and again in the outbound guard; the deterministic mode sends nothing off-machine. Harden the rules (Section 2.2) | Open |
| A conflicted file keeps its instrumented backup until the next service start, and a reverted edit waits for a restart before closing | Security | Low | Low | Hash-guarded restore never overwrites developer edits; the watcher flags conflicts live. Add a resolve action (Section 2.2) | Open |
| Supply-chain exceptions — the `prisma@7.10.0` provenance exclusion and 4 `no-downgrade` exceptions — widen trust | Security | Low | Low | Exact pins, lockfile review, `pnpm audit` and `check:advisories` in CI. Confirm the exceptions (Section 2.2) | Open |
| The CI workflow and macOS/Windows code paths have never run on real hosts, so the first hosted or cross-platform run may surface environment defects | Operational | Medium | Medium | Every CI command passes locally; platform branches are unit-tested with simulators. Run hosted CI and cross-platform validation (Section 2.2) | Open |
| Chrome DevTools embedding (`$0`, `onSelectionChanged`, theme events), MV3 idle eviction and a real VS Code window are exercised only through stubs and harnesses | Integration | Medium | Low | Browser and host tiers cover the same code paths; a reconnect and keepalive policy is in place. Manual QA pass (Section 2.2) | Open |
| Heavy capture or polling load: each `GET /sessions/:id` replays about 40 frames, and burst ingest near 2,000 events/s sheds about half the events | Operational | Low | Medium | Loss is bounded, counted and shown in capture coverage; retention caps growth. Tune replay and ingest (Section 2.2) | Open |

# 7. Visual Project Status

```mermaid
%%{init: {'theme':'base','themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieOuterStrokeColor':'#B23AF2','pieSectionTextColor':'#B23AF2'}}}%%
pie showData title Project Hours Breakdown
    "Completed Work" : 2776
    "Remaining Work" : 56
```

Remaining hours by priority (56 in total, matching Sections 1.2 and 2.2):

```mermaid
%%{init: {'theme':'base','themeVariables':{'xyChart':{'plotColorPalette':'#5B39F3'}}}}%%
xychart-beta
    title "Remaining Hours by Priority"
    x-axis ["High", "Medium", "Low"]
    y-axis "Hours" 0 --> 30
    bar [21, 26, 9]
```

| Priority | Tasks | Hours |
|---|---|---|
| High | Commit-history and divergence sign-off, first hosted CI run, live provider validation, real-host manual QA | 21 |
| Medium | Security confirmations, conflict resolution, readiness identity, naming decision, macOS/Windows, redaction hardening, install rehearsal | 26 |
| Low | Replay and ingest tuning, accessibility and wording polish | 9 |
| **Total** | | **56** |

# 8. Summary & Recommendations

The Custom Debugging Generator is delivered end to end and is **98.0% complete** against the AAP-scoped work: 2,776 of 2,832 hours. All twelve workspaces build from a fresh clone and pass strict type checking, lint and format checks. The unit, integration, extension-host, browser and end-to-end suites exercise the product with 24,980 passing Vitest tests at 89.3% statement coverage and 239 passing runtime tests. Every one of the user's four acceptance tests passes against the real stack. Checkout latency resolves to one cross-tier trace ending at the un-indexed `pool.query`. The render panel is built from a different component set and attributes `ProductCard` renders to the shipping-ETA context. Cleanup leaves the demo tree byte-identical, and an unseen fixture app reaches a generated panel with no demo knowledge in the product.

The safety model holds under test. File edits are journaled with both hashes before any write and restored only on a hash match. Developer edits are preserved as conflicts. Telemetry is redacted before storage, before the live tail and before model egress. The local service authenticates every client with role-bound credentials, pairs Chrome with one-time codes, and refuses every web origin. Model output is schema-validated, repaired at most twice, and otherwise replaced by a deterministic fallback that is labelled as such.

The remaining 56 hours are path-to-production work, not missing features. The critical path has four steps: run the workflow on GitHub-hosted runners; validate the live Anthropic provider with an explicitly chosen `DEBUGGEN_MODEL`; run a manual pass inside real Chrome DevTools and a real VS Code window; and have the owner sign off the commit-history exception and divergences D1–D8. Medium-priority items close the documented caveats: a conflict-resolution action, document identity for readiness, macOS and Windows validation, free-text redaction hardening and a clean-machine install rehearsal.

**Production readiness:** ready for internal use and demonstration on Linux with the deterministic provider today. It should be treated as release-candidate quality for wider distribution until the four high-priority tasks are closed. Success metrics for sign-off are:

| Metric | Target | Current |
|---|---|---|
| `pnpm verify` + `test:vscode` + `test:browser` + `test:e2e` | Green on GitHub-hosted runners | Green locally |
| Acceptance tests 1–4 with the live Anthropic provider | 4 of 4 reach `generated` without fallback | 4 of 4 with the deterministic provider |
| Residual `__DEBUGGEN__` markers after `session.end` | 0 | 0 |
| Open release decisions (D1, D2 confirmation, security address) | 0 | 3 |

# 9. Development Guide

## 9.1 System Prerequisites

- Linux or macOS. Every command below was verified on Linux; macOS and Windows code paths exist but have not been exercised (Section 3).
- Node.js **24.21.0** (`.nvmrc`); `node -v` must print `v24.21.0`.
- pnpm **12.4.2** through corepack (`packageManager` in `package.json`).
- Docker Engine with the Compose plugin, for PostgreSQL 18.6 (`postgres:18.6-alpine`).
- Google Chrome or Chromium **153 or later** (`minimum_chrome_version`).
- VS Code **1.125 or later**.
- `xvfb-run` for headless extension-host tests on Linux.
- About 4 CPU cores and 8 GB of RAM for the full test suite (`pnpm verify` takes roughly 12 minutes).

## 9.2 Environment Setup

Run from the repository root:

```bash
nvm use                                            # selects Node 24.21.0 from .nvmrc
corepack enable
corepack prepare pnpm@12.4.2 --activate
cp .env.example .env                               # service settings; the defaults are safe
cp apps/demo-app/.env.example apps/demo-app/.env   # DATABASE_URL and APP_ORIGIN for the demo
```

- The default provider is `deterministic`, which needs no key and sends nothing off the machine.
- For the real model, set `DEBUGGEN_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` and an explicit `DEBUGGEN_MODEL`. The service refuses to start with `CONFIG_INVALID` if either value is missing.
- Service state lives in `DEBUGGEN_HOME` (default `~/.debuggen`, created `0700`), outside every project.

## 9.3 Dependency Installation and Build

```bash
CI=true pnpm install --frozen-lockfile    # expect "Lockfile passes supply-chain policies"
pnpm build                                # prisma generate, then all 12 workspaces in dependency order
```

`pnpm build` produces three artifacts:

- `apps/local-service/dist/main.js`, the service.
- `apps/chrome-extension/dist/`, the unpacked MV3 extension.
- `apps/vscode-extension/dist/`, which embeds the service (`dist/service/main.js`), 13 prompt files and the Node preload.

## 9.4 Database (demo only)

```bash
pnpm demo:db          # docker compose up -d postgres (database lumen_supply, role debuggen/debuggen)
pnpm demo:migrate     # applies prisma/migrations/0001_init
pnpm demo:seed        # about 400 products, 6 warehouses, about 200,000 inventory movements (about 20 s)
```

If port 5432 is taken, set `POSTGRES_PORT` and the matching port in `DATABASE_URL` in both `.env` files.

## 9.5 Application Startup

Start these in order, each in its own terminal.

1. The local service, which serves HTTP and WebSocket on `127.0.0.1:43117`:

```bash
DEBUGGEN_PROVIDER=deterministic node apps/local-service/dist/main.js
```

2. The demo storefront with the telemetry preload. The CLI mints its own server-agent credential and needs the service running. For an uninstrumented server on `http://localhost:3000`, use `pnpm demo:dev` instead.

```bash
pnpm demo:instrumented
```

3. The extensions:
   - **Chrome:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `apps/chrome-extension/dist`.
   - **VS Code:** open the repository and press **F5** on **Run Extension**. Alternatively, install the self-contained VSIX:

```bash
pnpm --filter debug-generator run package
code --install-extension apps/vscode-extension/debug-generator-0.1.0.vsix
```

4. Pair them. Run **Debug Generator: Pair Chrome DevTools Panel** in VS Code. Then open the demo in Chrome, open DevTools, choose the **Debug Generator** panel and enter the 8-character code.

## 9.6 Verification Steps

The health check should return `{"version":"0.1.0","protocolVersion":"1.0.0","pairingAvailable":false}`:

```bash
curl -s http://127.0.0.1:43117/health
curl -s -o /dev/null -w "%{http_code}\n" -H 'Origin: https://evil.example' http://127.0.0.1:43117/health   # 403
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:43117/sessions                                  # 401
TOKEN=$(node -e 'console.log(require(process.env.HOME + "/.debuggen/auth.json").token)')
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:43117/sessions                                # 200, JSON list
```

These are the full quality gates, as run for Section 3. Omit `VSCODE_TEST_PATH` to let the test CLI download VS Code.

```bash
pnpm verify
VSCODE_TEST_PATH=/path/to/vscode/code xvfb-run -a pnpm test:vscode
pnpm test:browser
DATABASE_URL=postgresql://debuggen:debuggen@127.0.0.1:5432/lumen_supply pnpm test:e2e
pnpm check:advisories && pnpm audit --audit-level=low
```

## 9.7 Example Usage

1. In the DevTools panel, select the **Place order** button with **Pick element**. Then, in the VS Code **Debug Generator** view, ask *"Why is this button slow?"*.
2. Watch the progress rows: "Found CheckoutButton", then "Traced event handler", then "Ready to capture".
3. Choose **Start capture**, click **Place order** in the demo, then choose **Stop capture**.
4. The DevTools panel renders a timeline, flame chart, waterfall, query table and metric cards. Click the SQL row to jump to the `pool.query` call in `inventory.service.ts`.
5. Ask a follow-up such as *"Why did this query run twice?"*, then choose **End session**. `git status --porcelain apps/demo-app` should print nothing.

`docs/DEMO.md` scripts all three demonstrated questions step by step.

## 9.8 Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| Panel shows "Service not running" | Service stopped, or on another port | Start the service. If `DEBUGGEN_PORT` changed, set `debuggen.serviceUrl` and use **Change service address…** in the panel |
| Panel shows "Not paired" | Credential rotated or refused | Run **Pair Chrome DevTools Panel** again and enter the new code |
| "Could not enable Server spans / Database tracing" | Dev server was started without the preload | Relaunch with `pnpm demo:instrumented` or **Launch Dev Server** |
| "Reload the page…" row | Page loaded before the agent armed | Accept the one-click reload in the panel |
| `pnpm typecheck` fails in `.next/dev/types` | A stale, generated `apps/demo-app/.next` directory | `rm -rf apps/demo-app/.next` |
| Port still bound after stopping `next dev` | A `next-server` child outlives its parent | Stop both processes, and check the port is free before restarting |
| Service will not start with `anthropic` | `DEBUGGEN_MODEL` or `ANTHROPIC_API_KEY` is unset | Set both, or use `DEBUGGEN_PROVIDER=deterministic` |
| e2e cannot reach the demo | `DEMO_URL` and `PORT` disagree | Set `DEMO_URL=http://localhost:<PORT>` with the same `PORT` |

# 10. Appendices

## A. Command Reference

| Command | Purpose |
|---|---|
| `pnpm install --frozen-lockfile` | Reproducible install under the supply-chain policy in `pnpm-workspace.yaml` |
| `pnpm build` | `prisma generate`, then every workspace in dependency order |
| `pnpm dev` | Local service in watch mode (`tsx watch`) |
| `pnpm typecheck` | `prisma generate`, then `tsc -b` across the project references |
| `pnpm lint` / `pnpm format` / `pnpm format:check` | ESLint with `--max-warnings 0`; Prettier write / check |
| `pnpm test` | Every Vitest project, with v8 coverage |
| `pnpm test:integration` | The 18 in-process service integration files |
| `pnpm test:vscode` | Extension-host suite and packaged-VSIX smoke test (wrap in `xvfb-run -a` on Linux) |
| `pnpm test:browser` / `pnpm test:e2e` | Playwright `browser` and `e2e` projects |
| `pnpm demo:db` / `demo:migrate` / `demo:seed` | PostgreSQL through Compose, migration, seed |
| `pnpm demo:generate` / `demo:dev` / `demo:instrumented` | Prisma client, plain `next dev`, `next dev` with the telemetry preload |
| `pnpm check:no-hardcoding` / `check:no-residual-instrumentation` / `check:secrets` / `check:advisories` | Guard scripts |
| `pnpm verify` | Build, typecheck, lint, format:check, test, test:integration and the three guards |
| `pnpm --filter debug-generator run package` | Build `debug-generator-0.1.0.vsix` |

## B. Port Reference

| Port | Service | Override |
|---|---|---|
| 43117 | Local service HTTP and WebSocket (`/ws`), loopback only | `DEBUGGEN_PORT`, `DEBUGGEN_HOST`, VS Code `debuggen.serviceUrl` |
| 3000 | Demo storefront (`next dev`) | `PORT`, `DEMO_URL`, VS Code `debuggen.devServerUrl` |
| 3100 | Generalization fixture app (tests) | `SAMPLE_APP_PORT`, `FIXTURE_APP_URL` |
| 5432 | PostgreSQL 18.6 (Compose) | `POSTGRES_PORT` plus `DATABASE_URL` |
| 9229 | Node inspector for **Attach service** | `--inspect` flag |

## C. Key File Locations

| Concern | Path |
|---|---|
| Service entry, config, store schema | `apps/local-service/src/main.ts`, `src/config.ts`, `src/store/schema.sql` |
| Access boundary (credentials, origin policy, pairing) | `apps/local-service/src/server/auth.ts` |
| Six-stage pipeline and versioned prompts | `apps/local-service/src/pipeline/stages/`, `apps/local-service/prompts/manifest.json` |
| Cleanup and reconciliation | `apps/local-service/src/cleanup/cleanup.ts`, `packages/instrumentation/src/patch/patcher.ts` |
| Browser agent and Node preload | `packages/telemetry/src/browser/agent.ts`, `packages/telemetry/src/node/register.ts` |
| Redaction rules | `packages/telemetry/src/redaction/` |
| Message and HTTP contracts | `packages/protocol/src/messages/`, `packages/protocol/src/http.ts` |
| Panel catalog, renderer host, design tokens | `packages/panel-schema/src/catalog.ts`, `packages/panel-renderer/src/host/PanelHost.tsx`, `src/tokens/tokens.ts` |
| Deterministic provider | `packages/model-provider/src/providers/deterministic.ts` |
| Chrome manifest and service worker | `apps/chrome-extension/manifest.config.ts`, `src/background/service-worker.ts` |
| VS Code activation and URI handler | `apps/vscode-extension/src/extension.ts`, `src/uri-handler.ts` |
| Demo schema and seeded defects | `apps/demo-app/prisma/schema.prisma`, `docs/DEMO.md` §9 |
| CI | `.github/workflows/ci.yml` |
| Service state (outside every project) | `$DEBUGGEN_HOME/{auth.json, sessions.sqlite, backups/, index/}` |

## D. Technology Versions

| Technology | Version |
|---|---|
| Node.js / pnpm / TypeScript | 24.21.0 / 12.4.2 / 6.0.3 |
| Next.js / React | 16.3.6 / 19.3.0 |
| Prisma / `pg` / PostgreSQL | 7.10.0 / 8.23.0 / 18.6 |
| hono / ws / zod | 4.13.8 / 8.21.3 / 4.6.5 |
| ts-morph / bippy / `@anthropic-ai/sdk` | 28.0.0 / 0.7.3 / 0.127.0 |
| Vitest / Playwright / Vite / ESLint | 5.0.1 / 1.63.0 / 8.3.0 / 10.11.0 |
| Chrome floor / Chromium tested | 153 / 153.0.8010.12 |
| VS Code engine / VS Code tested | ^1.125.0 / 1.139.0 |
| Extension / protocol version | 0.1.0 / 1.0.0 |

## E. Environment Variable Reference

| Variable | Default | Purpose |
|---|---|---|
| `DEBUGGEN_PROVIDER` | `deterministic` | `deterministic` or `anthropic` |
| `ANTHROPIC_API_KEY`, `DEBUGGEN_MODEL` | empty | Both required when the provider is `anthropic` |
| `DEBUGGEN_HOST` / `DEBUGGEN_PORT` | `127.0.0.1` / `43117` | Service bind address |
| `DEBUGGEN_HOME` | `~/.debuggen` | Store, credentials, backups, index cache |
| `DEBUGGEN_LOG_LEVEL` / `DEBUGGEN_RETENTION_DAYS` | `info` / `30` | Logging level; session retention |
| `DEBUGGEN_PROMPTS_DIR` | built-in | Prompt directory; set by the VS Code extension for the embedded service |
| `DATABASE_URL` | `postgresql://debuggen:debuggen@localhost:5432/lumen_supply` | Demo database (development placeholder, allowlisted) |
| `APP_ORIGIN`, `NEXT_OTEL_VERBOSE` | — | Demo origin; optional Next.js span verbosity |
| `POSTGRES_PORT`, `COMPOSE_PROJECT_NAME` | `5432`, — | Compose overrides |
| `DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL`, `DEBUGGEN_PROJECT_ROOT` | minted | Set by the launcher for the preload. Never set these by hand |
| `DEMO_URL`, `FIXTURE_APP_URL`, `SAMPLE_APP_PORT` | `http://localhost:3000`, `http://localhost:3100`, — | Browser and e2e targets |
| `VSCODE_TEST_PATH`, `VSCODE_TEST_VERSION`, `DEBUGGEN_TEST_NODE`, `DEBUGGEN_VSCODE_TEST_KEEP_STATE`, `DEBUGGEN_VSCODE_TEST_TIMEOUT_MS` | — | Extension-host test controls |

VS Code settings: `debuggen.serviceUrl`, `debuggen.autoStartService`, `debuggen.devServerUrl`, `debuggen.provider`, `debuggen.model`.

## F. Developer Tools Guide

- **Launch configurations (`.vscode/launch.json`):**
  - Run Extension
  - Run Extension (with Debug service)
  - Debug service
  - Attach service (started with `--inspect` on port 9229)
  - Debug demo app (next dev)
  - Debug demo app (instrumented)
  - Compounds: **Extension + Service** and **Extension + attached service**
- **VS Code commands (12):**
  - Start Debugging Session, Start Capture, Stop Capture, End Session
  - Open Source Location, Launch Dev Server, Show File Modifications, Reopen Session
  - Start Local Service, Pair Chrome DevTools Panel, Rotate Service Token, Purge Stored Sessions
- **Chrome:** the **Debug Generator** DevTools panel. The service worker is inspected from `chrome://extensions` → *Inspect views*.
- **Single-project test run:** `pnpm exec vitest run --project <name>`. Project names are `shared`, `protocol`, `telemetry`, `instrumentation`, `panel-schema`, `panel-renderer`, `code-analysis`, `model-provider`, `local-service`, `local-service-integration`, `chrome-extension`, `vscode-extension-host`, `vscode-extension-webview` and `tooling`.

## G. Glossary

| Term | Meaning |
|---|---|
| Session | One debugging question and its follow-ups, persisted in `sessions.sqlite` |
| Capture | A bounded recording window whose telemetry is attributed to one session |
| Browser agent | MAIN-world script declared at `document_start`, dormant until a session arms it |
| Preload | Node module loaded through `NODE_OPTIONS=--import` that registers the tracer provider in the dev server |
| Instrumentation plan | Validated list of runtime hooks and reversible patches for one session |
| Modification record | Journal entry holding the original hash, instrumented hash, backup path and diff of one patched file |
| PanelSpec | Validated, catalog-constrained description of a generated debugging panel |
| Fact / Hypothesis | An observed statement backed by event evidence / an inferred cause with a confidence level |
| Deterministic provider | Rules-based, offline model provider used by every automated test |
| Pairing | One-time 8-character code exchange that issues the Chrome extension its credential |
