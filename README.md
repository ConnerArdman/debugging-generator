# Debug Generator

Debug Generator turns a plain-English question about your running React / Next.js app — _"Why is this button slow?"_ — into an interactive debugging panel built for that question, inside Chrome DevTools. It reads your codebase to find the code involved, installs the minimum temporary instrumentation needed to answer, records one correlated end-to-end trace while you reproduce the issue, and generates a panel in the **Debug Generator** DevTools tab in which runtime items link back to their source line in VS Code wherever that location can be resolved; an item whose location cannot be established is shown as unresolved rather than linked to a guess. When the session ends, all instrumentation is removed and every file it touched is restored byte for byte; a file you edited in the meantime is left as you wrote it and reported instead.

> **Status:** version 0.1.0 — a developer tool you build and install locally from this repository.

## Why it exists

Generic profilers answer generic questions: a flame chart of everything, a network log of everything, a React profile of everything, and you join them by hand across the browser, the server and the database. Debug Generator starts from your question instead. It works out which signals matter, captures only those, joins them into one ordered tree — browser event → React work → `fetch` → Next.js route handler → service functions → SQL and outbound calls — and composes a panel from a catalog of visualizations (timelines, waterfalls, flame-style hierarchies, render tables, component trees, request and query tables, state transitions, dependency graphs) chosen for what you asked. Different questions produce materially different panels.

Evidence and inference are kept apart: every **Observed** statement cites captured events, and every **Likely cause** carries a confidence level and a suggested source location.

## What it is not

- **Not cross-browser.** Chrome only, through a Manifest V3 DevTools extension.
- **Not a bug fixer.** It shows evidence and suggests likely causes; it never edits your code to fix them.
- **Not a hosted service.** Everything runs on your machine: the service binds to `127.0.0.1`, and with the `deterministic` model provider nothing Debug Generator captures or reads leaves the machine. Your project's dev server may still make its framework's own requests, such as Next.js's update check and telemetry ([what may leave the machine](docs/SECURITY.md#4-what-may-leave-the-machine-and-when)). There is no cloud component.
- **Not in a store.** It is not published to the Chrome Web Store or the VS Code Marketplace; you load the Chrome extension unpacked and install the VS Code extension from this checkout or from a locally packaged VSIX.
- **Not production tracing.** One developer, one local project, one question at a time.

## Screenshots

Both screenshots were captured from a real run of the demo walkthrough ([docs/DEMO.md](docs/DEMO.md)) with the `deterministic` model provider.

![The Debug Generator panel in Chrome DevTools, showing the panel generated for "Why is this button slow?" beside the demo storefront's order confirmation](docs/images/devtools-panel.png)

_The **Debug Generator** DevTools tab after a captured **Place order** click: **Observed** facts with their evidence chips, a **Likely cause** with its confidence and suggested source location, and the correlated browser, server and database timeline._

![The Debug Generator view in VS Code, showing the session's progress and the Sessions list beside the editor opened at the source line clicked in the DevTools panel](docs/images/vscode-view.png)

_The **Debug Generator** view in VS Code during the same session: investigation and instrumentation progress, the Sessions list, and the editor opened at the source location clicked in the DevTools panel._

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
| Chrome DevTools extension (Manifest V3) | `apps/chrome-extension`                          | The **Debug Generator** panel that renders generated panels, element selection by clicking in the inspected page (**Pick element**) or from the Elements panel, and a service worker that binds the inspected tab to a session and arms the page agent.                                            |
| Runtime instrumentation                 | `packages/telemetry`, `packages/instrumentation` | A browser agent (interactions, React commits, `fetch`/XHR with W3C `traceparent`, performance entries, errors, state) and a Node preload for the dev server (OpenTelemetry spans for requests, route handlers, Prisma and `pg`), plus adapters and a reversible patcher for named-function timing. |

Process boundaries, the protocol, the telemetry model, trace correlation, the reversibility mechanism and the key design decisions are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

| Tool          | Version                                                                                                              | How to get it                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js       | **24.21.0** (Active LTS) recommended, pinned in `.nvmrc` and `.node-version`; `engines.node` accepts `>=24.21.0 <25` | `nvm use`, or any version manager that reads those files                                                                                         |
| pnpm          | **12.4.2** recommended, pinned by `packageManager` in `package.json`; `engines.pnpm` accepts `>=12.4.2 <13`          | `corepack enable && corepack prepare pnpm@12.4.2 --activate`                                                                                     |
| PostgreSQL    | 18 (image `postgres:18.6-alpine`), for the demo and the end-to-end tests                                             | `pnpm demo:db` runs `docker compose up -d postgres`; requires Docker with Compose. Docker runs only the database — the product runs on the host. |
| Google Chrome | 153 or newer (`minimum_chrome_version` in the extension manifest)                                                    | [google.com/chrome](https://www.google.com/chrome/)                                                                                              |
| VS Code       | 1.125.0 or newer (`engines.vscode` `^1.125.0`)                                                                       | [code.visualstudio.com](https://code.visualstudio.com/)                                                                                          |

Everything else — TypeScript 6.0.3, the build tools and the test runners — is a dev dependency installed by pnpm at the version recorded in `pnpm-lock.yaml`.

## Installation

### 1. Clone, install and build

The repository at `https://github.com/ConnerArdman/debugging-generator` is access-controlled: an anonymous request for it answers HTTP 404, which is what GitHub returns for a repository you cannot see. Ask the repository owner for read access, then clone as an authenticated GitHub user — `gh repo clone ConnerArdman/debugging-generator` after `gh auth login`, `git clone git@github.com:ConnerArdman/debugging-generator.git` with an SSH key registered on your account, or the HTTPS URL below with a Git credential manager that supplies a personal access token when Git prompts for one. Never put a token in the clone URL: Git stores the URL, token included, in `.git/config`. If you received the source as an archive instead, unpack it and continue from `cd debugging-generator`.

```bash
git clone https://github.com/ConnerArdman/debugging-generator.git
cd debugging-generator
nvm use
corepack enable
corepack prepare pnpm@12.4.2 --activate
pnpm install --frozen-lockfile
pnpm build
```

`pnpm install --frozen-lockfile` installs exactly what `pnpm-lock.yaml` records and fails rather than resolve anything new. The workspace declares `engines.node` `>=24.21.0 <25` and `engines.pnpm` `>=12.4.2 <13`. Node.js 24.21.0 and pnpm 12.4.2 are the recommended pins — the versions `.nvmrc`, `.node-version` and `packageManager` name and the versions CI runs; another release inside those ranges satisfies the declared engines but is not what CI tests. Enforcement differs by tool: npm refuses a Node.js outside the range (`engine-strict=true` in `.npmrc`); pnpm 12.4.2 carries the same intent as `engineStrict: true` in `pnpm-workspace.yaml` but does not currently fail the install on `engines.node`; and corepack runs exactly the `packageManager` version. So confirm `node -v` and `pnpm -v` yourself first — `v24.21.0` and `12.4.2` are the versions to expect.

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

The VS Code extension starts its bundled service whenever a health check against `debuggen.serviceUrl` fails (setting `debuggen.autoStartService`, on by default), and on demand with **Debug Generator: Start Local Service**. When it starts the service, it chooses the child's `DEBUGGEN_PROVIDER` in this order, first match wins:

1. a `debuggen.provider` value you set explicitly in user, workspace or folder settings is forwarded;
2. otherwise a non-empty `DEBUGGEN_PROVIDER` already in the editor's own environment (for example exported in the shell VS Code was launched from) is left as it is;
3. otherwise the setting's default, `deterministic`, is forwarded.

So with neither set, the bundled service runs the `deterministic` provider, which needs no model account and sends nothing off the machine. To use `anthropic`, set `debuggen.provider` to `anthropic` and give it a model id in `debuggen.model`, which the extension forwards as `DEBUGGEN_MODEL` (left empty, a `DEBUGGEN_MODEL` inherited by the editor is kept; no model id is built in). `ANTHROPIC_API_KEY` is never a setting: it must be in the environment VS Code was started from, which the bundled service inherits; without the key or a model the service does not start and names the missing variable. Both settings reach only a service the extension starts — a service you started yourself keeps its own environment and `.env`. Before you ask a question, check the provider actually in effect: at the default `info` log level the service logs `model provider and prompts ready` with a `provider` field when it starts, in the **Debug Generator Service** output channel when the extension started it, or on its own standard output when you did.

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

The two files have different readers:

- **Root `.env`** — loaded by the local service (through dotenv, from the directory the service is started in, so start it from the repository root) and by Docker Compose, which interpolates `docker-compose.yml` from it. Its provider, host, port, prompt-directory, state-directory, log-level and retention values are the defaults the service already applies. `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL` are empty because they have no default: with `DEBUGGEN_PROVIDER=anthropic` the service refuses to start until both are set. With the default provider, an empty root `.env` therefore configures the service identically. The `DATABASE_URL` and `NEXT_OTEL_VERBOSE` lines are not service settings, but they are not inert: the service loads them into its own environment with the rest of the file, a dev server it launches (**Launch Dev Server**, `pnpm demo:instrumented`, the e2e suite) inherits that environment, and an inherited value wins over the project's own `.env`, because Next.js and the demo's `prisma.config.ts` never overwrite a variable that is already set. Keep the root `DATABASE_URL` identical to the demo's, or delete the line from your root `.env`, when the demo's own file should decide.
- **`apps/demo-app/.env`** — loaded by the demo's Prisma configuration (migrate and seed) and by Next.js. The demo's `DATABASE_URL` takes effect here or from the process environment, which wins — including a value a service-launched dev server inherited from the service — and it has no default: without it the migrate and seed commands stop and the storefront's queries fail to connect. The same file sets `APP_ORIGIN`, the address the storefront is served on.

[.env.example](.env.example) and [apps/demo-app/.env.example](apps/demo-app/.env.example) document each variable in place, and [Environment variables](#environment-variables) lists every variable with its reader, type and default. The one real decision is the model provider:

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

Workspaces are named `@debuggen/<directory>`, except the VS Code extension, whose package name is `debug-generator`. At runtime and in the bundlers, cross-package imports resolve through each dependency's built `dist/`, so a workspace's dependencies must be built before it; `pnpm build` does this in order, and `pnpm --filter <package> build` rebuilds a single workspace. Type-checking and lint read each dependency's source instead and need no prior build ([`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md#3-workspace-layout-and-dependency-layering)).

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

The demo contains deliberately seeded, non-trivial defects — a slow multi-tier interaction, an excessive-render pattern and duplicate network requests — of the kind that survive code review. The product has no knowledge of them: it finds them through code analysis, instrumentation, telemetry and analysis, and `pnpm check:no-hardcoding` fails the build if any demo identifier or route appears in product source, prompts, templates or repository tooling, or if repository tooling names one of the demo's files by path or pins one with a glob. Where they are and how they work is documented only in [docs/DEMO.md](docs/DEMO.md) — the end-to-end acceptance suite under `tests/e2e/` asserts against them at run time — which is also the scripted walkthrough: ask _"Why is this button slow?"_, capture one interaction, read the generated panel, click through to source, then ask the rendering and duplicate-request questions and verify cleanup.

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

   The preload is `packages/telemetry/dist/node/register.mjs` in a checkout, or its copy inside the VSIX. Server-side spans need an OpenTelemetry tracer provider _inside_ the `next dev` process before Next.js starts, and the preload registers one (with Prisma and `pg` instrumentation), so your project's source is not touched for this signal. The credential is scoped to that one project and expires when the process exits, which is why the launcher sets these values rather than you: a preload attached by hand has no valid credential and stays inert — the app serves normally but records no server or database spans. `node scripts/dev-instrumented.mjs --spawn-local`, which runs the `dev` script from your terminal rather than through the launcher, is not such a case: it requests a server-agent credential scoped to the project from the running service and refuses to start without one.

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

Every variable a product component, the demo, Docker Compose or a test runner reads, grouped by reader. Each group says where its values come from; the process environment always wins over a file.

#### Local service

Read from the root `.env` (loaded through dotenv from the directory the service is started in) or from the service's process environment. An empty or whitespace-only value counts as unset: it gets the default, or, for `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL`, which have none, stays unset. A value outside the accepted set, or `DEBUGGEN_PROVIDER=anthropic` without both of those, stops the service at start-up with a `CONFIG_INVALID` error that names the variable and how to fix it.

| Variable                  | Type and accepted values                                                                                      | Default                                             | Meaning                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEBUGGEN_PROVIDER`       | enum: `deterministic` or `anthropic`                                                                          | `deterministic`                                     | Model provider: rules-based and fully local, or the Anthropic API                                                                                                               |
| `ANTHROPIC_API_KEY`       | non-empty string                                                                                              | none                                                | Anthropic API key; required with `anthropic` (the service refuses to start without it), unused otherwise. Keep it in `.env`, never in a tracked file; its value is never logged |
| `DEBUGGEN_MODEL`          | non-empty string (a model id)                                                                                 | none, never defaulted                               | Model id for `anthropic`; required with it (the service refuses to start without it)                                                                                            |
| `DEBUGGEN_HOST`           | a loopback interface: `127.0.0.1`, another `127.0.0.0/8` address, `localhost` or `::1` (`[::1]` accepted)     | `127.0.0.1`                                         | Interface the service binds to; a wildcard or routable address is refused                                                                                                       |
| `DEBUGGEN_PORT`           | integer `0`–`65535`; `0` lets the operating system choose a free port                                         | `43117`                                             | Port for both HTTP and WebSocket                                                                                                                                                |
| `DEBUGGEN_PROMPTS_DIR`    | absolute path, `~`, or a path starting with `~/` (expanded against your home directory); `~user/…` is refused | the `prompts/` directory shipped beside the service | Alternative versioned prompt directory; the VS Code extension sets it for its bundled service                                                                                   |
| `DEBUGGEN_HOME`           | absolute path, `~`, or a path starting with `~/` (expanded against your home directory); `~user/…` is refused | `~/.debuggen`                                       | Session database, file backups, code-index cache and the editor credential; keep it outside every checkout                                                                      |
| `DEBUGGEN_LOG_LEVEL`      | enum: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                          | `info`                                              | Service log threshold                                                                                                                                                           |
| `DEBUGGEN_RETENTION_DAYS` | integer `0` or more; `0` purges everything eligible on the next sweep                                         | `30`                                                | Days after which sessions, telemetry, panels, analyses and their backups are purged                                                                                             |

`DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL` and `DEBUGGEN_PROJECT_ROOT` are not service settings: the tool injects them into the dev-server processes it launches. Never set them by hand: a token you set yourself is never valid.

#### Demo application and Next.js

Read by `apps/demo-app` from `apps/demo-app/.env` — loaded by `prisma.config.ts` for the Prisma CLI (`demo:migrate`, `demo:seed`) and by Next.js for the storefront — or from the process environment. The process environment wins over the file. The demo never opens the root `.env` itself, but a dev server the local service launches inherits the service's environment, including what the service loaded from the root `.env` — so the root example's `DATABASE_URL` and `NEXT_OTEL_VERBOSE` reach a service-launched demo and take precedence over `apps/demo-app/.env`. Keep the two copies identical.

| Variable            | Type and accepted values                                                                            | Default                                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | a `postgresql://` connection URL                                                                    | none                                                 | The demo database. Required by `pnpm demo:migrate` and `pnpm demo:seed`, which stop without it, and by the running storefront, whose queries fail to connect without it; `demo:generate`, `build` and `typecheck` need none. Both example files carry `postgresql://debuggen:debuggen@localhost:5432/lumen_supply`, the local Docker Compose development credential, not a secret                                                                                                                                                                                                                                                                                                            |
| `APP_ORIGIN`        | an `http:` or `https:` origin — scheme, host and port, with no credentials, path, query or fragment | unset; the demo example sets `http://localhost:3000` | The address the storefront is served on, and the only authority it calls itself on (checkout's calls to the simulated carrier and payment processor, and server-rendered pages' own reads). A request's scheme and port must match it exactly; `localhost`, `127.0.0.1` and `[::1]` count as one host when the value names one of them. A value that is set but is not an origin is treated as a mistake: every self-addressed call fails rather than falling back to the unset behaviour. Change it whenever you change the demo's port                                                                                                                                                     |
| `NEXT_OTEL_VERBOSE` | exactly `1` turns it on; any other value, or unset, leaves it off                                   | unset                                                | Read by the Next.js server process, not by the service. With `1`, Next.js also makes its internal spans and hands them to the registered tracer provider (the preload's, when attached); it prints nothing. The preload emits framework-internal spans only when they carry an error (`classifySpan` in `packages/telemetry/src/node/convert.ts`) and compensates for the shape they give each request (below), so the flag adds no evidence, only work on the request path. Leave it unset unless you work on server-side capture; set it where the dev server's environment comes from — `apps/demo-app/.env`, the shell which starts it, or the root `.env` of a service that launches it |

With `APP_ORIGIN` unset, the demo accepts only an `http` address whose host is `localhost`, `127.0.0.1` or `[::1]`, on any port, and a page rendered on the server addresses its own reads to `http://127.0.0.1:<PORT>`. Any other host — a LAN address, a custom host name, `https` or a proxy in front of the dev server — is refused, so set `APP_ORIGIN` to the exact origin in those cases, and on any machine where other processes listen on local ports.

**`NEXT_OTEL_VERBOSE` and the captured trace.** With the flag set, Next.js delegates every internal span, so a request's span sits beneath request-handler spans, its route handler beneath render and response spans, and Next.js leaves the request span named after the method alone (`POST`), because it renames that span only when it is the root of the request's work. None of those framework-internal spans reaches the capture unless it ends in an error, so the preload's span processor (`packages/telemetry/src/node/exporter.ts`) settles each emitted span's parent itself: it names the nearest ancestor the preload does emit, and a request span that resolved no route of its own takes the route its handler reported. A capture's trace tree and request names are therefore the same with or without the flag; what the flag adds is that every internal span is created, classified and discarded on the dev server's request path.

#### Local PostgreSQL container

Read by `docker compose` itself, from the process environment or the root `.env`: `POSTGRES_PORT` when it interpolates `docker-compose.yml`, and `COMPOSE_PROJECT_NAME` when it names the project.

| Variable               | Type and accepted values                                                                      | Default                       | Meaning                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PORT`        | TCP port number                                                                               | `5432`                        | Host port the demo database is published on; keep `DATABASE_URL`'s port in step                                                                              |
| `COMPOSE_PROJECT_NAME` | Compose project name: lowercase letters, digits, `-` and `_`, starting with a letter or digit | the checkout directory's name | Names the container `<project>-postgres-1` and the data volume `<project>_postgres-data`; set it only when two checkouts sit in directories of the same name |

`docker-compose.yml` sets no fixed container name, so a second checkout or worktree gets its own container and volume: to run it side by side, give it its own `POSTGRES_PORT` and the matching port in its `DATABASE_URL`, then run `pnpm demo:db` there as usual.

#### Test suites

Read from the process environment only — the test runners do not load `.env` — so export them in the shell that runs the suite. None is needed on a normal checkout, and an empty value counts as unset.

| Variable                          | Read by                                                                                | Type and accepted values                                                                                                                                               | Default                                                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEBUGGEN_HOST`, `DEBUGGEN_PORT`  | `playwright.config.ts`, `tests/browser/fixtures.ts`                                    | as for the service                                                                                                                                                     | `127.0.0.1`, `43117`                                                                               | Address of the service the Playwright suites start (or, outside CI, reuse when one already answers) and connect to                                                                                                                                                                                                                                                                                                                                  |
| `DEBUGGEN_HOME`                   | `playwright.config.ts`                                                                 | absolute path                                                                                                                                                          | `<repo>/test-results/debuggen-home`                                                                | Session home of the service the Playwright suites start, so a run never writes into your real `~/.debuggen`                                                                                                                                                                                                                                                                                                                                         |
| `DEBUGGEN_PROVIDER`               | `playwright.config.ts`                                                                 | as for the service                                                                                                                                                     | `deterministic`                                                                                    | Provider of the service the Playwright suites start; an exported value is honoured                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_URL`                    | `playwright.config.ts`, `tests/e2e/helpers/demo-app.ts`                                | a `postgresql://` connection URL                                                                                                                                       | none; `apps/demo-app/.env` applies                                                                 | When set, forwarded to the service the suites start and to the e2e suite's `demo:migrate` and `demo:seed` runs                                                                                                                                                                                                                                                                                                                                      |
| `DEMO_URL`                        | `playwright.config.ts`, `tests/e2e/**`                                                 | `http` origin                                                                                                                                                          | `http://localhost:3000`                                                                            | Origin of the demo the e2e suite launches through the product launcher; change it only when the demo's dev server is on another port                                                                                                                                                                                                                                                                                                                |
| `FIXTURE_APP_URL`                 | `playwright.config.ts`, `tests/browser/fixtures.ts`, `tests/e2e/helpers/sample-app.ts` | `http` origin                                                                                                                                                          | `http://localhost:3100`                                                                            | Origin of the fixture app (`tests/fixtures/sample-next-app`) the browser suite and `generalization.spec.ts` drive                                                                                                                                                                                                                                                                                                                                   |
| `SAMPLE_APP_PORT`                 | `tests/e2e/helpers/sample-app.ts`                                                      | integer `1024`–`65535`, different from the demo's and the service's ports                                                                                              | the port of `FIXTURE_APP_URL` (`3100`)                                                             | Serves the fixture app on another port for the e2e suite; wins over `FIXTURE_APP_URL`'s port                                                                                                                                                                                                                                                                                                                                                        |
| `DEBUGGEN_E2E_PNPM`               | `tests/e2e/helpers/repo.ts`                                                            | path of a pnpm executable, or of pnpm's `pnpm.cjs` (run with the current Node)                                                                                         | `pnpm` from `PATH`                                                                                 | The pnpm the e2e suite runs for `demo:migrate`, `demo:seed` and the clean-clone install, build and typecheck; set it where no pnpm shim is on `PATH`, or on Windows                                                                                                                                                                                                                                                                                 |
| `VSCODE_TEST_VERSION`             | `apps/vscode-extension/.vscode-test.mjs`                                               | `stable`, `insiders`, a commit id, or `X.Y.Z` satisfying `engines.vscode` `^1.125.0`                                                                                   | `stable`                                                                                           | The editor build `pnpm test:vscode` downloads                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VSCODE_TEST_PATH`                | `apps/vscode-extension/.vscode-test.mjs`                                               | absolute path of an installed VS Code executable                                                                                                                       | unset: an editor is downloaded                                                                     | Runs the suites in that editor instead of downloading one, and wins over `VSCODE_TEST_VERSION`; a path that is not an existing file fails the run                                                                                                                                                                                                                                                                                                   |
| `DEBUGGEN_VSCODE_TEST_TIMEOUT_MS` | `apps/vscode-extension/.vscode-test.mjs`                                               | integer `0` or more, in milliseconds; `0` disables timeouts                                                                                                            | `600000` (10 minutes)                                                                              | Mocha timeout per test and hook                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DEBUGGEN_VSCODE_TEST_KEEP_STATE` | `apps/vscode-extension/.vscode-test.mjs`                                               | `1` or `true` keeps; `0` or `false` removes; anything else fails the run                                                                                               | removed                                                                                            | Keeps the run's throwaway directory (logs under `user-data/logs/`) and prints its path                                                                                                                                                                                                                                                                                                                                                              |
| `DEBUGGEN_TEST_NODE`              | `apps/vscode-extension/.vscode-test.mjs`, `apps/vscode-extension/test/helpers.ts`      | absolute path of an existing Node.js executable file, or a command name looked up on `PATH`; use the repository's Node (`>=24.21.0 <25`), though no version is checked | the Node running the test CLI                                                                      | The Node an extension-host suite runs its own Node programs with — in the commands suite, the stand-in dev server and the standalone service processes it starts from `dist/service/main.js` — never the editor's Electron; an absolute path that is not an existing file fails the tests that use it. The service the extension itself starts (the packaged-VSIX suite's) does not use it: it runs on the runtime `src/service/process.ts` chooses |
| `VSCODE_TEST_EXECUTABLE_PATH`     | `apps/vscode-extension/test/helpers.ts`                                                | absolute path of the editor executable; internal                                                                                                                       | unset: the suites fall back to the extension host's `process.execPath`, which is the editor binary | Injected by `.vscode-test.mjs` into the editor it starts only when `VSCODE_TEST_PATH` selects an installed editor, naming the binary whose CLI the suites drive for `--install-extension`; never set it yourself                                                                                                                                                                                                                                    |

The extension-host harness removes every inherited `DEBUGGEN_*` and `ANTHROPIC_*` variable from the editor it starts and sets `DEBUGGEN_PROVIDER=deterministic` and a throwaway `DEBUGGEN_HOME` there, so a `DEBUGGEN_*` or `ANTHROPIC_*` variable exported in your shell never reaches the editor `pnpm test:vscode` runs; `DEBUGGEN_TEST_NODE` is the one `DEBUGGEN_*` name it passes on, after reading it itself.

#### Provided by the framework or the operating system

Set by Next.js, a CI runner, the shell or pnpm, and listed because the commands above read them. Do not put them in `.env`.

| Variable       | Read by                                                                | Type and accepted values                       | Default                                   | Effect                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`         | the demo (`apps/demo-app/src/server/origin.ts`)                        | integer `1`–`65535`                            | the port `next dev` or `next start` bound | Next.js publishes the port it actually bound here. With `APP_ORIGIN` unset, a server-rendered page addresses its own reads to `http://127.0.0.1:<PORT>`, and a page whose port cannot be read shows its error notice rather than guess. Choose the demo's port with `next dev -p <port>`, or by exporting `PORT` in the shell that starts it, and keep `APP_ORIGIN` in step |
| `CI`           | `playwright.config.ts`                                                 | any non-empty value counts as set              | unset locally; set by CI runners          | Forbids `test.only`, retries a failing test once, and makes Playwright start its own service (failing if one already answers on the service address) rather than reuse it                                                                                                                                                                                                   |
| `PATH`         | `scripts/dev-instrumented.mjs`, the VS Code extension, the test suites | the platform's search path                     | the shell's                               | Where `dev-instrumented.mjs --spawn-local` finds `pnpm` (else `npm`); where the VS Code extension finds `node` for the bundled service when the editor's own Node is older than 24 (absolute entries only); where the suites find `pnpm` and `node` unless configured above                                                                                                 |
| `PATHEXT`      | `scripts/dev-instrumented.mjs` (Windows)                               | `;`-separated file extensions                  | `.COM;.EXE;.BAT;.CMD`                     | Extensions tried, in order, when finding `pnpm` or `npm` on `PATH`                                                                                                                                                                                                                                                                                                          |
| `ComSpec`      | `scripts/dev-instrumented.mjs` (Windows)                               | path of the command interpreter                | `cmd.exe`                                 | Runs a `.cmd` or `.bat` package-manager launcher such as `pnpm.cmd` for `--spawn-local`                                                                                                                                                                                                                                                                                     |
| `npm_execpath` | `tests/browser/fixtures.ts`                                            | path of the package manager running the script | set by pnpm for `pnpm test:browser`       | When it names pnpm, the browser suite runs that same pnpm; otherwise `pnpm` from `PATH`                                                                                                                                                                                                                                                                                     |

### VS Code settings

| Setting                     | Default                  | Meaning                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debuggen.serviceUrl`       | `http://127.0.0.1:43117` | Base URL of the local service; must match `DEBUGGEN_HOST` and `DEBUGGEN_PORT`                                                                                                                                                                                                              |
| `debuggen.autoStartService` | `true`                   | Start the bundled service when a health check against `debuggen.serviceUrl` fails; turn off to manage the service yourself                                                                                                                                                                 |
| `debuggen.devServerUrl`     | _empty_                  | Dev-server URL of the project you are debugging, for example `http://127.0.0.1:3000`; empty lets the service detect or launch it                                                                                                                                                           |
| `debuggen.provider`         | `deterministic`          | Provider for the bundled service, applied only when the extension starts it. Precedence: a value you set explicitly here, then a non-empty `DEBUGGEN_PROVIDER` inherited by the editor, then this default ([details](#4-start-the-local-service)); `anthropic` also needs `debuggen.model` |
| `debuggen.model`            | _empty_                  | Model id for `anthropic`, forwarded as `DEBUGGEN_MODEL` when the extension starts the service; empty keeps an inherited `DEBUGGEN_MODEL`. `ANTHROPIC_API_KEY` comes only from the environment VS Code was started from                                                                     |

The Chrome extension connects to the address saved in its pairing dialog's **Service address** field, `http://127.0.0.1:43117` by default. Once paired, change it with **Change service address…** on the panel's connection pill.

### Where state lives

Everything the tool keeps for itself lives under `DEBUGGEN_HOME` (default `~/.debuggen`), deliberately **outside** every checkout, so none of it ever appears in your `git status`:

- `sessions.sqlite` — sessions, progress, plans, the modification journal with diffs, redacted captures, panels, analyses and credential hashes;
- `backups/` — the original bytes of every file the tool instrumented;
- `index/` — the code-index cache;
- `auth.json` — the editor credential.

Your project's own files are the exception. Named-function timing edits tracked source files in place, so while a session is instrumented each patched file shows as modified in `git status`. Cleanup restores it byte for byte and it is clean again; a file you edited while it was instrumented is reported as a conflict and stays modified with your edit, because the tool never overwrites it ([what it changes, and how it undoes it](#what-it-changes-in-your-project-and-how-it-undoes-it)).

Directories are created with mode `0700` and files with `0600`. Sessions older than `DEBUGGEN_RETENTION_DAYS` (30 days by default) are purged on service start, and **Debug Generator: Purge Stored Sessions** runs the same purge on demand; backups of unresolved conflicts are kept until the conflict is resolved. End every session before deleting the directory yourself — the backups are the record of what your files contained. Details: [docs/SECURITY.md](docs/SECURITY.md#8-session-data-at-rest).

## Troubleshooting

Walkthrough-specific cases are in [docs/DEMO.md](docs/DEMO.md#10-if-something-doesnt-line-up); these are the general ones.

**The panel's pill reads "Not paired".**

- **Cause:** the Chrome extension has no service credential yet, or it was revoked by **Rotate Service Token**.
- **Fix:** run **Debug Generator: Pair Chrome DevTools Panel** in VS Code and enter the code in the panel's pairing dialog ([pairing](#5-pair-chrome-with-the-service)).

**The pill reads "Service not running".**

- **Cause:** nothing answers at `http://127.0.0.1:43117`.
- **Fix:** run **Debug Generator: Start Local Service** or `node apps/local-service/dist/main.js`, then `curl -s http://127.0.0.1:43117/health`. If the service is running on another `DEBUGGEN_PORT`, set `debuggen.serviceUrl` to match, and set the same address in the Chrome panel with **Change service address…**.

**The service refuses to start with `FS_UNSAFE_PATH`.**

- **Cause:** `DEBUGGEN_HOME` (default `~/.debuggen`), or something under it, is not private to you. Every directory from `DEBUGGEN_HOME` down must be a real directory (not a symbolic link) owned by you with mode `0700`, and every file in it a regular, single-link file owned by you with mode `0600`, because it holds the editor credential, captured telemetry and the backups of your patched files ([where state lives](#where-state-lives)). The service refuses rather than repairs, and changes nothing: it prints the offending path — and, for a permission problem, its mode and the required `0700` — on stderr, and records the reason as `details.reason` in its log.
- **Fix,** by reason:
  - `group-or-other-permissions` — the directory grants group or other access, typically `0755` after `mkdir ~/.debuggen` under the default umask `022`. Check what it contains, then run `chmod 700 <dir>`; or, if you just created it and it is empty, remove it and let the service create it.
  - `symlink-component` — the path, or a directory on the way to it, is a symbolic link. Replace the link with a real directory, or set `DEBUGGEN_HOME` to the real path, one reached without a link.
  - `foreign-owner` — another account owns it, for example because it was created with `sudo`. Set `DEBUGGEN_HOME` to a directory you own; or, if it is meant to be yours, check what it contains and run `sudo chown -R "$USER" <dir>`.
  - `not-a-directory` — a file or other entry occupies a path that must be a directory. Move or remove that entry.
  - `not-a-regular-file` — a directory, FIFO, socket or device sits where a state file such as `sessions.sqlite` or `auth.json` belongs. Move that entry aside so the service can create a private file in its place.
  - `multiply-linked` — a state file has a second hard link, so its contents are reachable from outside `DEBUGGEN_HOME`. Remove the other link, or replace the file with a copy of itself that has a single link.

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

- **Cause:** a Node.js outside `engines.node` `>=24.21.0 <25` or a pnpm outside `engines.pnpm` `>=12.4.2 <13`. npm refuses such a Node.js outright (`engine-strict=true`); pnpm 12.4.2 does not currently fail on `engines.node`, so an unsupported Node.js can instead surface later as a build, test or runtime error.
- **Fix:** switch to the recommended pins — `nvm use` (or install 24.21.0) and `corepack enable && corepack prepare pnpm@12.4.2 --activate` — confirm `node -v` and `pnpm -v`, and run `pnpm install --frozen-lockfile` again.

**The service port or PostgreSQL's port is already in use.**

- **Cause:** another process holds 43117 or 5432.
- **Fix:** stop that process; or move the database with `POSTGRES_PORT` (and the port in `DATABASE_URL`) and the service with `DEBUGGEN_PORT` (and `debuggen.serviceUrl`), and set the new service address in the Chrome panel with **Change service address…**.

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

| Command                 | Scope                                                                                | Needs                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`             | Unit and component tests for every workspace, plus the guard-script tests            | `pnpm build` (packages import each other's `dist/`)                                                                                                                   |
| `pnpm test:integration` | The local service in-process on an ephemeral port, with the deterministic provider   | `pnpm build`                                                                                                                                                          |
| `pnpm test:vscode`      | VS Code extension-host suite, including `vsce` manifest checks and a VSIX smoke test | `pnpm build`; a display (CI runs it under `xvfb-run -a`); a VS Code download, or `VSCODE_TEST_PATH` naming an installed editor ([test-suite variables](#test-suites)) |
| `pnpm test:browser`     | The built Chrome extension in Chromium against the fixture app                       | `pnpm build`; Playwright's Chromium, installed once per machine (below)                                                                                               |
| `pnpm test:e2e`         | The full demo flows, cleanup and generalization                                      | `pnpm build`; Playwright's Chromium, installed once per machine (below); PostgreSQL migrated and seeded (`demo:db`, `demo:migrate`, `demo:seed`)                      |

`pnpm install` does not download a browser. Before the first `pnpm test:browser` or `pnpm test:e2e` on a machine, install the Chromium build the pinned Playwright expects, together with the operating-system libraries it needs — the same step CI runs:

```bash
pnpm exec playwright install --with-deps chromium
```

`--with-deps` installs those libraries through the system package manager (on Linux it may ask for `sudo`); run `pnpm exec playwright install chromium` instead when they are already present. Repeat the step after an upgrade of `@playwright/test`.

`pnpm verify` is the aggregate local gate: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:integration`, `check:no-hardcoding`, `check:no-residual-instrumentation` and `check:secrets`, in that order. It does not run the extension-host, browser or end-to-end suites; CI runs `pnpm verify` and additionally `test:vscode`, `test:browser` and `test:e2e` (the last with a PostgreSQL service container), on pushes and pull requests to `master` and `blitzy`. Every automated suite uses `DEBUGGEN_PROVIDER=deterministic` — the Playwright suites unless you export another provider ([test-suite variables](#test-suites)) — so none needs a model account or network access to a provider.

## License

MIT — see [LICENSE](LICENSE).
