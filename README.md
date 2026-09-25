# Debug Generator

Debug Generator turns a plain-English question about your running React / Next.js app — _"Why is this button slow?"_ — into an interactive debugging panel built for that question, inside Chrome DevTools. It reads your codebase to find the code involved, installs the minimum temporary instrumentation needed to answer, records one correlated end-to-end trace while you reproduce the issue, and generates a panel in the **Debug Generator** DevTools tab in which every runtime item links back to its source line in VS Code. When the session ends, all instrumentation is removed and every file it touched is restored byte for byte; a file you edited in the meantime is left as you wrote it and reported instead.

> **Status:** version 0.1.0 — a developer tool you build and install locally from this repository.

## Why it exists

Generic profilers answer generic questions: a flame chart of everything, a network log of everything, a React profile of everything, and you join them by hand across the browser, the server and the database. Debug Generator starts from your question instead. It works out which signals matter, captures only those, joins them into one ordered tree — browser event → React work → `fetch` → Next.js route handler → service functions → SQL and outbound calls — and composes a panel from a catalog of visualizations (timelines, waterfalls, flame-style hierarchies, render tables, component trees, request and query tables, state transitions, dependency graphs) chosen for what you asked. Different questions produce materially different panels.

Evidence and inference are kept apart: every **Observed** statement cites captured events, and every **Likely cause** carries a confidence level and a suggested source location.

## What it is not

- **Not cross-browser.** Chrome only, through a Manifest V3 DevTools extension.
- **Not a bug fixer.** It shows evidence and suggests likely causes; it never edits your code to fix them.
- **Not a hosted service.** Everything runs on your machine: the service binds to `127.0.0.1`, and with the `deterministic` model provider nothing leaves the machine at all. There is no cloud component.
- **Not in a store.** It is not published to the Chrome Web Store or the VS Code Marketplace; you load the Chrome extension unpacked and install the VS Code extension from this checkout or from a locally packaged VSIX.
- **Not production tracing.** One developer, one local project, one question at a time.

## Screenshots

Screenshots of the DevTools panel and the VS Code view are added here once they are captured from a real run. Until then, [docs/DEMO.md](docs/DEMO.md) describes what each step of the walkthrough shows.

## Supported stack

| Layer              | Supported                                                                  |
| ------------------ | -------------------------------------------------------------------------- |
| Target application | React, Next.js (App Router, including route handlers), TypeScript, Node.js |
| Database           | PostgreSQL through Prisma and/or `pg`                                      |
| Editor             | VS Code 1.125.0 or newer                                                   |
| Browser            | Google Chrome 153 or newer                                                 |

Instrumentation is organised as adapters (`packages/instrumentation`), so other frameworks are _possible_ — adding one means implementing and registering an adapter, see [Extending the system](docs/ARCHITECTURE.md#13-extending-the-system-writing-an-adapter) — but only the stack above is delivered.

## Architecture at a glance

Four components cooperate. You ask the question in VS Code; the local service runs a six-stage pipeline (problem understanding, code investigation, instrumentation planning, runtime capture, analysis, panel generation) in which every model output is schema-validated and every plan is applied by deterministic tooling, never by the model; the runtime instrumentation reports telemetry while you reproduce the issue; and the DevTools panel renders the generated panel from the captured data.

| Component                               | Where                                            | Role                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code extension                       | `apps/vscode-extension`                          | Control surface: question entry, live progress, relevant files, file modifications with diffs, capture controls, analysis, follow-ups, the Sessions tree and opening source at a location. Starts the local service on demand.                                                                     |
| Local coordination service              | `apps/local-service`, `127.0.0.1:43117`          | Sessions and their store, code indexing, the pipeline, instrumentation, telemetry ingest with redaction and correlation, panel generation and validation, source-open forwarding, dev-server launching and cleanup.                                                                                |
| Chrome DevTools extension (Manifest V3) | `apps/chrome-extension`                          | The **Debug Generator** panel that renders generated panels, element selection from the Elements panel, and a service worker that binds the inspected tab to a session and arms the page agent.                                                                                                    |
| Runtime instrumentation                 | `packages/telemetry`, `packages/instrumentation` | A browser agent (interactions, React commits, `fetch`/XHR with W3C `traceparent`, performance entries, errors, state) and a Node preload for the dev server (OpenTelemetry spans for requests, route handlers, Prisma and `pg`), plus adapters and a reversible patcher for named-function timing. |

Process boundaries, the protocol, the telemetry model, trace correlation, the reversibility mechanism and the key design decisions are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

| Tool          | Version                                                                  | How to get it                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js       | **24.21.0** (Active LTS), pinned in `.nvmrc` and `.node-version`         | `nvm use`, or any version manager that reads those files                                                                                         |
| pnpm          | **12.4.2**, pinned by `packageManager` in `package.json`                 | `corepack enable && corepack prepare pnpm@12.4.2 --activate`                                                                                     |
| PostgreSQL    | 18 (image `postgres:18.6-alpine`), for the demo and the end-to-end tests | `pnpm demo:db` runs `docker compose up -d postgres`; requires Docker with Compose. Docker runs only the database — the product runs on the host. |
| Google Chrome | 153 or newer (`minimum_chrome_version` in the extension manifest)        | [google.com/chrome](https://www.google.com/chrome/)                                                                                              |
| VS Code       | 1.125.0 or newer (`engines.vscode` `^1.125.0`)                           | [code.visualstudio.com](https://code.visualstudio.com/)                                                                                          |

Everything else — TypeScript 6.0.3, the build tools and the test runners — is a dev dependency installed by pnpm at the version recorded in `pnpm-lock.yaml`.

## Installation

### 1. Clone, install and build

```bash
git clone https://github.com/ConnerArdman/debugging-generator.git
cd debugging-generator
nvm use
corepack enable
corepack prepare pnpm@12.4.2 --activate
pnpm install --frozen-lockfile
pnpm build
```

`pnpm install --frozen-lockfile` installs exactly what `pnpm-lock.yaml` records and fails rather than resolve anything new. The workspace declares `engines.node` `>=24.21.0 <25` with engine-strict mode on (`engine-strict=true` in `.npmrc`, `engineStrict: true` in `pnpm-workspace.yaml`); no other Node.js version is supported, so confirm `node -v` prints `v24.21.0` first.

`pnpm build` runs `pnpm demo:generate` (`prisma generate`, which needs no database) and then builds every workspace in dependency order. It produces the three artifacts you load next: the local service (`apps/local-service/dist/main.js`), the unpacked Chrome extension (`apps/chrome-extension/dist`) and the VS Code extension (`apps/vscode-extension/dist`).

### 2. Load the Chrome extension

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Choose **Load unpacked** and select `apps/chrome-extension/dist`.

Build before loading: the extension's `prebuild` step copies the browser agent bundle (`packages/telemetry/dist/browser-agent.iife.js`) into `apps/chrome-extension/public/agent.iife.js`, so the agent is only inside the extension after `pnpm build`. After a rebuild, press the reload button on the extension's card. The extension requests `storage`, `alarms` and `tabs`, and host access to `http://localhost/*` and `http://127.0.0.1/*` only; [docs/SECURITY.md](docs/SECURITY.md#91-chrome-extension) explains each permission.

### 3. Install the VS Code extension

Choose one:

- **Extension Development Host.** Open this repository in VS Code, choose the **Run Extension** launch configuration (`.vscode/launch.json`) and press **F5**.
- **VSIX.** Package the extension and install it into your everyday VS Code:

  ```bash
  pnpm --filter debug-generator run package
  code --install-extension apps/vscode-extension/debug-generator-0.1.0.vsix
  ```

  The VSIX embeds the local service, its prompt files and the Node preload, so an installed extension needs nothing else from this checkout.

Either way, a **Debug Generator** container appears in the Activity Bar with two views: **Session** and **Sessions**.

### 4. Start the local service

The VS Code extension starts its bundled service whenever a health check against `debuggen.serviceUrl` fails (setting `debuggen.autoStartService`, on by default), and on demand with **Debug Generator: Start Local Service**. When it does, it forwards the `debuggen.provider` setting as `DEBUGGEN_PROVIDER` — and that setting defaults to `anthropic`, so set it to `deterministic` for a run without a model account.

To run the service yourself, start it from the repository root so it reads the root `.env`:

```bash
node apps/local-service/dist/main.js
```

and check that it is ready:

```bash
curl -s http://127.0.0.1:43117/health
```

The health route answers with the service `version`, its `protocolVersion` and whether `pairingAvailable` is true. On first start the service creates `~/.debuggen` (mode `0700`) and writes the editor credential to `~/.debuggen/auth.json` (mode `0600`), where the VS Code extension reads it; nothing needs to be copied.

`pnpm dev` runs the service from source in watch mode (`tsx watch`) for working on the service itself. pnpm runs that script inside `apps/local-service`, so it reads `apps/local-service/.env` rather than the root `.env`; export the variables in your shell instead.

### 5. Pair Chrome with the service

The service authenticates every client. The VS Code extension reads its credential from `auth.json`, but a Chrome extension cannot read files, so the DevTools panel pairs with a one-time code:

1. Open your app on `localhost`, open DevTools and select the **Debug Generator** tab (it may sit behind the `»` overflow). While the connection pill reads **Not paired**, press **Pair…**.
2. In VS Code, run **Debug Generator: Pair Chrome DevTools Panel** (or press **Pair Chrome DevTools** in the Session view). It shows an 8-character pairing code.
3. Enter the code in the panel's pairing dialog and press **Pair**. The pill reads **Connected**.

A code is single-use and expires after 5 minutes. The extension keeps the credential it receives, so you pair again only after it is revoked: **Debug Generator: Rotate Service Token** revokes every credential and closes every connection, after which Chrome must pair again and any dev server the service launched must be relaunched.

## Development setup

### Environment files

```bash
cp .env.example .env
cp apps/demo-app/.env.example apps/demo-app/.env
```

The root `.env` is read by the local service; `apps/demo-app/.env` is read by the demo's Prisma configuration and by Next.js. Every value in the root example is the default the service already applies, [.env.example](.env.example) documents each variable in place, and the demo's example names the Compose database and the address the storefront is served on. The one real decision is the model provider:

- **`DEBUGGEN_PROVIDER=deterministic`** (the default) — rules-based, needs no key, makes no network call and sends nothing off the machine; every automated test uses it. It still runs the real pipeline: it builds each stage's output from the structured inputs the pipeline hands it (code-graph candidates, capture aggregates).
- **`DEBUGGEN_PROVIDER=anthropic`** — requires `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL` (no model id is ever hardcoded). Redacted, bounded code excerpts and telemetry aggregates are sent to the Anthropic API; [docs/SECURITY.md](docs/SECURITY.md#4-what-may-leave-the-machine-and-when) lists exactly what each stage sends.

`.env` files are git-ignored. Never put a key in a tracked file; `pnpm check:secrets` fails the build on one.

### Repository layout

```text
apps/
  vscode-extension/   VS Code extension: control surface, webview view, bundled service
  chrome-extension/   Manifest V3 DevTools extension: panel, service worker, content scripts
  local-service/      Local coordination service: sessions, store, pipeline, versioned prompts, cleanup
  demo-app/           "Lumen Supply" Next.js demo, an instrumentation target that imports nothing from the product
packages/
  protocol/           Message envelope, WebSocket and HTTP schemas, session record, client SDK
  telemetry/          Telemetry event schema, redaction, correlation, aggregates, browser agent, Node preload
  instrumentation/    Plan schema, adapter interface and registry, adapters, reversible patcher, cleanup
  panel-schema/       Panel specification DSL, node catalog, syntactic and semantic validation
  panel-renderer/     Design tokens, primitives, layout and visualization components, PanelHost
  code-analysis/      ts-morph indexer, code graph and queries, route map, source-map resolver
  model-provider/     Provider interface, Anthropic and deterministic providers, prompt loader, redaction guard
  shared/             Ids, hashing, paths, SourceLocation, result and error types, logger
docs/                 Architecture, demo walkthrough, security model
scripts/              Guard scripts and the dev-instrumented launcher
tests/                Playwright browser and end-to-end suites, generalization fixture app
```

Workspaces are named `@debuggen/<directory>`, except the VS Code extension, whose package name is `debug-generator`. Cross-package imports resolve through each dependency's built `dist/`, so a workspace's dependencies must be built before it; `pnpm build` does this in order, and `pnpm --filter <package> build` rebuilds a single workspace.

### Commands

All are root `package.json` scripts.

| Command                                  | What it does                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                             | `pnpm demo:generate`, then every workspace's `build` in dependency order                                         |
| `pnpm dev`                               | The local service from source in watch mode                                                                      |
| `pnpm typecheck`                         | `pnpm demo:generate`, then `tsc -b` over every project                                                           |
| `pnpm lint`                              | ESLint over the repository with `--max-warnings 0`                                                               |
| `pnpm format` / `pnpm format:check`      | Prettier: rewrite / check every file                                                                             |
| `pnpm test`                              | Vitest unit and component tests with coverage, including the guard-script tests                                  |
| `pnpm test:integration`                  | Local-service integration tests: an in-process service with the deterministic provider                           |
| `pnpm test:vscode`                       | VS Code extension-host tests, including a packaged-VSIX smoke test                                               |
| `pnpm test:browser`                      | Playwright `browser` project: the built Chrome extension against the fixture app                                 |
| `pnpm test:e2e`                          | Playwright `e2e` project: the full stack against the demo                                                        |
| `pnpm verify`                            | The aggregate local gate (see [Testing and quality gates](#testing-and-quality-gates))                           |
| `pnpm demo:db`                           | `docker compose up -d postgres`                                                                                  |
| `pnpm demo:generate`                     | `prisma generate` for the demo; needs no database                                                                |
| `pnpm demo:migrate`                      | Checks the committed migrations against the Prisma schema, then applies them                                     |
| `pnpm demo:seed`                         | Resets the demo tables and loads the data set                                                                    |
| `pnpm demo:dev`                          | The demo's `next dev`, without instrumentation                                                                   |
| `pnpm demo:instrumented`                 | The demo through the service's launcher, with the Node preload and a credential (`scripts/dev-instrumented.mjs`) |
| `pnpm check:no-hardcoding`               | Fails if product source, prompts or templates contain demo-specific identifiers or question matching             |
| `pnpm check:no-residual-instrumentation` | Fails if the demo's tracked source contains an instrumentation marker or its worktree is not clean               |
| `pnpm check:secrets`                     | Fails on committed credentials, keys or tracked `.env` files                                                     |

## Running the demo

The repository ships a demo application to debug, **Lumen Supply**: a B2B industrial-supply storefront with catalog, product, cart, checkout, orders and inventory dashboard pages, backed by real PostgreSQL queries through Prisma 7 (with the `pg` driver adapter) and raw `pg`, over a seeded data set of realistic volume. It is an ordinary Next.js App Router application: it imports nothing from the product.

```bash
pnpm demo:db        # PostgreSQL 18 in Docker
pnpm demo:migrate   # apply the schema
pnpm demo:seed      # load the data set (around half a minute)
pnpm demo:dev       # serve it on http://localhost:3000, without instrumentation
```

`pnpm demo:dev` is enough to browse the store. For a debugging session, start the demo with the instrumentation preload instead: run **Debug Generator: Launch Dev Server** in VS Code, or, with the local service running and VS Code connected to it with this repository (or `apps/demo-app`) open,

```bash
pnpm demo:instrumented
```

and open the URL it prints (`http://localhost:3000` unless that port is taken). The service launches only projects inside a workspace folder the connected editor announced, so without VS Code the command is refused with an explanation.

The demo contains deliberately seeded, non-trivial defects — a slow multi-tier interaction, an excessive-render pattern and duplicate network requests — of the kind that survive code review. The product has no knowledge of them: it finds them through code analysis, instrumentation, telemetry and analysis, and `pnpm check:no-hardcoding` fails the build if any demo identifier appears in product code. Where they are and how they work is recorded only in [docs/DEMO.md](docs/DEMO.md), which is also the scripted walkthrough: ask _"Why is this button slow?"_, capture one interaction, read the generated panel, click through to source, then ask the rendering and duplicate-request questions and verify cleanup.

## Debugging another project

### What a target project needs

- A React app on **Next.js with the App Router**; server-side capture covers route handlers (`app/**/route.ts`).
- **TypeScript** with a `tsconfig.json` at the project root — the code index is built from it.
- For database spans, **PostgreSQL through Prisma and/or `pg`**.
- A `dev` script in its `package.json`, which the launcher runs.
- A dev server on `http://localhost` or `http://127.0.0.1` — the only origins the Chrome extension's host permissions cover.

### Session workflow

1. **Open the project in VS Code** with the extension installed. The workspace folder is the project root. The dev server is `debuggen.devServerUrl` when that is set; otherwise the service detects one running for the folder, or launches one.
2. **Start the dev server with the preload** — one of:
   - **Debug Generator: Launch Dev Server** (or **Launch dev server** in the Session view): the service runs the project's `dev` script with the preload attached.
   - From a terminal in this repository, while VS Code has the project open and connected to the service: `node scripts/dev-instrumented.mjs --project /path/to/your-app`. It is the command-line equivalent of that command — it asks the service's launcher to start the project, prints the dev-server URL and pid, and stops the server on Ctrl-C (`--detach` returns at once and `--stop` stops it later; `--help` lists every option).

   Either way the launcher runs your `dev` script with this environment:

   ```text
   NODE_OPTIONS="<your NODE_OPTIONS> --import file:///…/register.mjs"
   DEBUGGEN_INGEST_URL=<service ingest endpoint>
   DEBUGGEN_TOKEN=<server-agent credential for this project, minted per launch>
   DEBUGGEN_PROJECT_ROOT=<absolute project root>
   ```

   The preload is `packages/telemetry/dist/node/register.mjs` in a checkout, or its copy inside the VSIX. Server-side spans need an OpenTelemetry tracer provider _inside_ the `next dev` process before Next.js starts, and the preload registers one (with Prisma and `pg` instrumentation), so your project's source is not touched for this signal. The credential is scoped to that one project and expires when the process exits, which is why the launcher sets these values rather than you: a preload attached by hand has no valid credential and stays inert — the app serves normally but records no server or database spans (`--spawn-local` demonstrates exactly that).

3. **Open the app in Chrome**, open DevTools, select the **Debug Generator** tab and pair if the pill reads **Not paired**.
4. **Ask your question** in the Session view. Optionally inspect an element and press **Use selected element** in the panel so the investigation starts from it.
5. **Watch the progress** — the files, handlers and routes the investigation found, then the signals being prepared — until **Ready to capture**.
6. **Capture**: press **Start capture**, reproduce the issue, press **Stop capture**. The generated panel appears in DevTools; source chips open the matching line in VS Code.
7. **Ask follow-ups** in the Session view; the tool reuses the stored capture when it answers the question and asks you to reproduce again when it needs more evidence.
8. **End the session** with **End session** (or **Debug Generator: End Session**).

### What it changes in your project, and how it undoes it

- **Runtime hooks first.** Interactions, React renders, network requests, server requests, route handlers and database queries come from the browser agent and the Node preload without touching a file.
- **Only named-function timing edits files.** When the plan times a specific function, an AST patch wraps it so its original body still runs exactly once.
- **Recorded before written.** Before any write, the original content and its SHA-256 hash are saved under `~/.debuggen/backups/`, and the change is journalled together with the hash the file is expected to have afterwards; the write itself is atomic.
- **Visible.** Every modification is listed under **File modifications** in the Session view, each with **View diff**.
- **Restored.** Ending the session — or closing VS Code, or the next service start after a crash — restores every file byte for byte and verifies the restored hash.
- **Never overwrites your edits.** A file you edit while it is instrumented is reported as a conflict and left exactly as you wrote it; its original stays in the backup directory.

The full guarantees, and what stays loaded in a launched dev server afterwards, are in [docs/SECURITY.md](docs/SECURITY.md#6-generated-instrumentation-risks-and-reversibility-guarantees).

## Configuration

### Environment variables

Set in `.env` at the repository root (see [.env.example](.env.example)) or in the service's environment.

| Variable                  | Default                                                      | Meaning                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEBUGGEN_PROVIDER`       | `deterministic`                                              | Model provider: `deterministic` (rules-based, fully local) or `anthropic`                                                                             |
| `ANTHROPIC_API_KEY`       | _empty_                                                      | Anthropic API key, used only with `anthropic`; keep it in `.env`, never in a tracked file                                                             |
| `DEBUGGEN_MODEL`          | _empty_                                                      | Model id for `anthropic`; required with it                                                                                                            |
| `DEBUGGEN_HOST`           | `127.0.0.1`                                                  | Loopback interface the service binds to                                                                                                               |
| `DEBUGGEN_PORT`           | `43117`                                                      | Port for both HTTP and WebSocket                                                                                                                      |
| `DEBUGGEN_PROMPTS_DIR`    | _empty_                                                      | Absolute path of an alternative versioned prompt directory; empty uses the shipped `prompts/` (the VS Code extension sets it for its bundled service) |
| `DEBUGGEN_HOME`           | `~/.debuggen`                                                | Session database, file backups, code-index cache and the editor credential                                                                            |
| `DEBUGGEN_LOG_LEVEL`      | `info`                                                       | Service log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                                                     |
| `DEBUGGEN_RETENTION_DAYS` | `30`                                                         | Days after which sessions, telemetry, panels, analyses and their backups are purged                                                                   |
| `DATABASE_URL`            | `postgresql://debuggen:debuggen@localhost:5432/lumen_supply` | The demo database — the local Docker Compose development credential, not a secret                                                                     |
| `NEXT_OTEL_VERBOSE`       | _unset_                                                      | `1` makes Next.js log the OpenTelemetry spans it emits; noisy                                                                                         |

The Playwright suites read `DEMO_URL` (default `http://localhost:3000`) and `FIXTURE_APP_URL` (default `http://localhost:3100`) from the process environment only, so export them in the shell that runs the suites. Docker Compose reads `POSTGRES_PORT` (default `5432`) and `POSTGRES_CONTAINER_NAME` (default `debuggen-postgres`) from the environment or the root `.env`; keep `DATABASE_URL`'s port in step with `POSTGRES_PORT`. The demo additionally reads `APP_ORIGIN`, which [apps/demo-app/.env.example](apps/demo-app/.env.example) sets to `http://localhost:3000`: the address the storefront is served on, port included, and the only authority the demo will call itself on. Change it whenever you change the demo's port. Left unset, the demo accepts any `http` address on this machine.

`DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL` and `DEBUGGEN_PROJECT_ROOT` are injected by the tool into the dev-server processes it launches. Never set them by hand: a token you set yourself is never valid.

### VS Code settings

| Setting                     | Default                  | Meaning                                                                                                                          |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `debuggen.serviceUrl`       | `http://127.0.0.1:43117` | Base URL of the local service; must match `DEBUGGEN_HOST` and `DEBUGGEN_PORT`                                                    |
| `debuggen.autoStartService` | `true`                   | Start the bundled service when a health check against `debuggen.serviceUrl` fails; turn off to manage the service yourself       |
| `debuggen.devServerUrl`     | _empty_                  | Dev-server URL of the project you are debugging, for example `http://127.0.0.1:3000`; empty lets the service detect or launch it |
| `debuggen.provider`         | `anthropic`              | Forwarded as `DEBUGGEN_PROVIDER` when the extension starts the bundled service; set `deterministic` for a key-less, local run    |

The Chrome extension connects to the service at `http://127.0.0.1:43117`, so keep the default host and port for interactive sessions.

### Where state lives

Everything the tool keeps lives under `DEBUGGEN_HOME` (default `~/.debuggen`), deliberately **outside** every checkout, so a session never changes your `git status`:

- `sessions.sqlite` — sessions, progress, plans, the modification journal with diffs, redacted captures, panels, analyses and credential hashes;
- `backups/` — the original bytes of every file the tool instrumented;
- `index/` — the code-index cache;
- `auth.json` — the editor credential.

Directories are created with mode `0700` and files with `0600`. Sessions older than `DEBUGGEN_RETENTION_DAYS` (30 days by default) are purged on service start, and **Debug Generator: Purge Stored Sessions** runs the same purge on demand; backups of unresolved conflicts are kept until the conflict is resolved. End every session before deleting the directory yourself — the backups are the record of what your files contained. Details: [docs/SECURITY.md](docs/SECURITY.md#8-session-data-at-rest).

## Troubleshooting

Walkthrough-specific cases are in [docs/DEMO.md](docs/DEMO.md#10-if-something-doesnt-line-up); these are the general ones.

**The panel's pill reads "Not paired".**

- **Cause:** the Chrome extension has no service credential yet, or it was revoked by **Rotate Service Token**.
- **Fix:** run **Debug Generator: Pair Chrome DevTools Panel** in VS Code and enter the code in the panel's pairing dialog ([pairing](#5-pair-chrome-with-the-service)).

**The pill reads "Service not running".**

- **Cause:** nothing answers at `http://127.0.0.1:43117`.
- **Fix:** run **Debug Generator: Start Local Service** or `node apps/local-service/dist/main.js`, then `curl -s http://127.0.0.1:43117/health`. If the service is running on another `DEBUGGEN_PORT`, set `debuggen.serviceUrl` to match — and return to the default port for Chrome.

**The pill reads "Reconnecting…".**

- **Cause:** Manifest V3 suspends an idle service worker after roughly 30 seconds, or the service restarted.
- **Fix:** usually none — the worker reconnects with exponential backoff (0.5 s up to 10 s) and an alarm keepalive, and the page agent buffers events until the connection returns. If it persists, check that the service is running.

**Progress asks you to reload the page.**

- **Cause:** the tab was loaded before the extension was, so the React hook was not in place before React started and renders cannot be observed.
- **Fix:** accept the one-click reload; the agent loads before React on the next navigation.

**"Could not enable Server spans" or "Could not enable Database tracing".**

- **Cause:** the dev server was started without the preload (for example with a plain `next dev` or `pnpm demo:dev`), so no server or database telemetry exists.
- **Fix:** stop it and relaunch with **Debug Generator: Launch Dev Server**, `pnpm demo:instrumented`, or the relaunch command shown in the message. Capture continues with the signals that are available.

**"No telemetry was captured."**

- **Cause:** nothing happened on the page while capture was running.
- **Fix:** start capture, reproduce the issue in the page, stop capture, then **Capture again** if prompted.

**A file is reported as edited while instrumented.**

- **Cause:** you changed a file the session had patched. This is a conflict, reported rather than resolved for you.
- **Fix:** nothing is lost — the tool does not overwrite your edit, and the original is kept at the backup path shown with the message; use **Open diff** to compare and restore what you need.

**Install or build errors that mention engines, or an unsupported Node.js or pnpm version.**

- **Cause:** a Node.js version other than 24.21.0, or a pnpm other than 12.4.2; the workspace is pinned to both (`engines`, `packageManager`) and runs engine-strict on purpose.
- **Fix:** `nvm use` (or install 24.21.0) and `corepack enable && corepack prepare pnpm@12.4.2 --activate`, confirm `node -v` and `pnpm -v`, and run `pnpm install --frozen-lockfile` again.

**The service port or PostgreSQL's port is already in use.**

- **Cause:** another process holds 43117 or 5432.
- **Fix:** stop that process; or move the database with `POSTGRES_PORT` (and the port in `DATABASE_URL`) and the service with `DEBUGGEN_PORT` (and `debuggen.serviceUrl`), remembering that the Chrome extension uses the default service address.

**`pnpm demo:db` fails.**

- **Cause:** Docker is not running, or Compose is unavailable.
- **Fix:** start Docker, then `pnpm demo:db` and `docker compose ps postgres` until the container reports `(healthy)`.

**Database errors in the demo.**

- **Cause:** PostgreSQL is not up, or the schema or data are missing, or `apps/demo-app/.env` is absent.
- **Fix:** copy `apps/demo-app/.env.example` to `apps/demo-app/.env`, then rerun `pnpm demo:db`, `pnpm demo:migrate` and `pnpm demo:seed`.

**The Prisma client is missing on a clean clone.**

- **Cause:** the demo's generated client under `apps/demo-app/src/generated/prisma` is git-ignored.
- **Fix:** `pnpm demo:generate` (it is also the first step of `pnpm build` and `pnpm typecheck`).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components and process boundaries, protocol, telemetry model and correlation, instrumentation and reversibility, AI stages, panel generation, source mapping, adapters and key decisions.
- [docs/DEMO.md](docs/DEMO.md) — the scripted end-to-end walkthrough and the seeded defects.
- [docs/SECURITY.md](docs/SECURITY.md) — what is captured, what may leave the machine, redaction, the model boundary, instrumentation risks, the service access boundary and extension permissions.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.

## Testing and quality gates

| Command                 | Scope                                                                                | Needs                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `pnpm test`             | Unit and component tests for every workspace, plus the guard-script tests            | `pnpm build` (packages import each other's `dist/`)                                   |
| `pnpm test:integration` | The local service in-process on an ephemeral port, with the deterministic provider   | `pnpm build`                                                                          |
| `pnpm test:vscode`      | VS Code extension-host suite, including `vsce` manifest checks and a VSIX smoke test | `pnpm build`; a display (CI runs it under `xvfb-run -a`)                              |
| `pnpm test:browser`     | The built Chrome extension in Chromium against the fixture app                       | `pnpm build`                                                                          |
| `pnpm test:e2e`         | The full demo flows, cleanup and generalization                                      | `pnpm build`, PostgreSQL migrated and seeded (`demo:db`, `demo:migrate`, `demo:seed`) |

`pnpm verify` is the aggregate local gate: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:integration`, `check:no-hardcoding`, `check:no-residual-instrumentation` and `check:secrets`, in that order. It does not run the extension-host, browser or end-to-end suites; CI runs `pnpm verify` and additionally `test:vscode`, `test:browser` and `test:e2e` (the last with a PostgreSQL service container), on pushes and pull requests to `master` and `blitzy`. Every automated suite uses `DEBUGGEN_PROVIDER=deterministic`, so none needs a model account or network access to a provider.

## License

MIT — see [LICENSE](LICENSE).
