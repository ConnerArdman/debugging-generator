# Demo walkthrough

This is the script that proves Debug Generator works: a clean machine, the bundled "Lumen Supply" storefront, three debugging questions, three generated panels, and a session that ends with every piece of instrumentation removed. Follow it top to bottom; every step ends with a line telling you what you should see, so the first step that does not match is the one to look at.

**Prerequisites** (Node.js, pnpm, Docker, Chrome, VS Code), installation details and the configuration reference live in the [README](../README.md). This document assumes them and does not repeat them.

## Contents

1. [What you will see](#1-what-you-will-see)
2. [One-time setup](#2-one-time-setup)
3. [Start the stack](#3-start-the-stack)
4. [Walkthrough 1 — "Why is this button slow?"](#4-walkthrough-1--why-is-this-button-slow)
5. [Walkthrough 2 — "Why is this component rendering so many times?"](#5-walkthrough-2--why-is-this-component-rendering-so-many-times)
6. [Walkthrough 3 — "Why are these requests duplicated?"](#6-walkthrough-3--why-are-these-requests-duplicated)
7. [How the three panels differ](#7-how-the-three-panels-differ)
8. [End the session and verify cleanup](#8-end-the-session-and-verify-cleanup)
9. [The seeded defects](#9-the-seeded-defects)
10. [If something doesn't line up](#10-if-something-doesnt-line-up)
11. [Running the same flow automatically](#11-running-the-same-flow-automatically)

## 1. What you will see

You ask a plain-English question in VS Code about a page you have open in Chrome; Debug Generator reads the project's code, instruments the running app temporarily, and asks you to reproduce the problem. It then correlates what that one interaction did in the browser, the Next.js server and PostgreSQL into a single trace and renders a debugging panel built for the question — in the **Debug Generator** tab of Chrome DevTools — whose rows open the matching source line in VS Code. Three different questions produce three materially different panels, and ending the session restores every file it touched byte for byte.

## 2. One-time setup

Run these from the repository root:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
cp apps/demo-app/.env.example apps/demo-app/.env
pnpm build
```

You should see: the install finish without resolving anything new (the lockfile is authoritative), and `pnpm build` finish with every workspace built. `pnpm build` runs `pnpm demo:generate` (`prisma generate`) first, which needs no database, so it works before PostgreSQL is running. The build produces the three things this walkthrough loads: the local service (`apps/local-service/dist/main.js`), the unpacked Chrome extension (`apps/chrome-extension/dist`) and the VS Code extension (`apps/vscode-extension/dist`).

**Choose a model provider.** The copied `.env` already sets `DEBUGGEN_PROVIDER=deterministic`: a rules-based provider that needs no key, makes no network call and sends nothing off the machine. It is what every automated test uses, so this whole walkthrough is reproducible without a model account. It is not a shortcut: the deterministic provider only fills in the stage outputs from the structured inputs the pipeline hands it (code-graph candidates, capture aggregates), and every panel still comes out of the real pipeline — code analysis, a validated instrumentation plan, real telemetry, a validated analysis and a validated panel specification.

To reason with the hosted model instead, set these three lines in `.env` — they are file entries, not shell commands — replacing `<your key>` with your own Anthropic API key and `<model id>` with the id of the model you want to use:

```dotenv
DEBUGGEN_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
DEBUGGEN_MODEL=<model id>
```

`DEBUGGEN_MODEL` is required with `anthropic`, because the product never hardcodes a model id. `.env` is git-ignored; never put a key in a tracked file. What each provider may send is documented in [SECURITY.md](SECURITY.md#4-what-may-leave-the-machine-and-when).

## 3. Start the stack

Six steps, in this order: the demo needs its database, the instrumented launch needs the service, and pairing needs both extensions and a running demo.

### Step 1 — PostgreSQL

```bash
pnpm demo:db
docker compose ps postgres
```

`pnpm demo:db` is `docker compose up -d postgres`: it starts the single Compose service `postgres` (image `postgres:18.6-alpine`, container `<project>-postgres-1`, database `lumen_supply`, port 5432) in the background, with its data in the named volume `<project>_postgres-data` so nothing appears in your working tree. `<project>` is the Compose project name: the checkout directory's name unless `COMPOSE_PROJECT_NAME` is set, so every checkout or worktree gets its own container and volume; a second one running side by side needs only its own `POSTGRES_PORT` (see [README.md](../README.md#local-postgresql-container)).

You should see: within a few seconds, `docker compose ps postgres` reports the container as `(healthy)` — that is its `pg_isready` healthcheck passing.

### Step 2 — Schema and data

```bash
pnpm demo:generate
pnpm demo:migrate
pnpm demo:seed
```

`demo:generate` writes the Prisma client (already done by `pnpm build`; repeating it is harmless). `demo:migrate` first runs `check:migration`, which replays the committed migrations in order and requires them to reproduce `prisma/schema.prisma` exactly, then applies both of them with `prisma migrate deploy`:

- `prisma/migrations/0001_init` — the baseline: the twelve tables, their keys and their indexes.
- `prisma/migrations/0002_cart_checkout_key` — adds `carts.checkout_key`, the name of the checkout attempt that claimed the cart (the checkout submission's `idempotencyKey`). It is written when a checkout claims the cart, kept when the cart becomes an order, and cleared when a checkout that did not finish puts the cart back. The column is unique, so one attempt name holds at most one cart, and a repeated submission with the same key is answered with that attempt's own outcome — the order it placed or the cart it holds — instead of placing a second order, by any process, after any restart.

The history is incremental: an applied migration is never edited, and a later schema change arrives as a new migration. `demo:seed` resets every table and loads the data set.

You should see: `check-migrations: 2 migrations reproduce prisma/schema.prisma (149 schema objects)`, then Prisma applying `0001_init` and `0002_cart_checkout_key` and reporting `All migrations have been successfully applied.` (on a database that already has both, `No pending migrations to apply.`), then seed progress lines prefixed `lumen-supply seed:` and, at the end, this table (the seed uses a fixed random seed, so the counts are exact):

```text
lumen-supply seed: row counts
  categories                12
  products                 400
  warehouses                 6
  inventory_levels        2400
  inventory_movements   200000
  price_rules              896
  customers                 40
  carts                     60
  cart_items               212
  orders                   300
  order_items             1052
  shipping_quotes          305
lumen-supply seed: done in ‹elapsed›
```

Seeding takes a little while — around half a minute on a laptop — because the volume is the point: 200 000 inventory movements (500 per product) are what make the slow query in walkthrough 1 slow. With a partial seed it looks fast.

### Step 3 — Local service

From the repository root (so the service reads the `.env` you copied):

```bash
node apps/local-service/dist/main.js
```

Then, in a second terminal:

```bash
curl -s http://127.0.0.1:43117/health
```

You should see: a JSON log line `the Debug Generator service is listening` with its URL, and the health route answer with the service `version`, `protocolVersion` (`"1.0.0"`) and whether `pairingAvailable` is true. The service creates `$DEBUGGEN_HOME` (default `~/.debuggen`, mode `0700`) with the session database, the backup directory and the index cache, and on first start writes the editor credential that the VS Code extension and `pnpm demo:instrumented` authenticate with to `auth.json` (mode `0600`) in the same directory. Nothing prints it, and you never need to copy it anywhere.

Alternatively, let VS Code run it: the command **Debug Generator: Start Local Service** (`debuggen.startService`) starts the service bundled with the extension, and with `debuggen.autoStartService` enabled (the default) the extension starts it by itself whenever its health check fails. When VS Code starts the service it forwards the `debuggen.provider` setting as `DEBUGGEN_PROVIDER` and a non-empty `debuggen.model` as `DEBUGGEN_MODEL`; the provider defaults to `deterministic`, so a key-less run needs no setting. For `anthropic`, set `debuggen.model` and start VS Code from an environment that has `ANTHROPIC_API_KEY`, which is never read from settings.

### Step 4 — Load the two extensions

**VS Code.** Open this repository in VS Code, choose the **Run Extension** launch configuration and press F5. An Extension Development Host window opens with `apps/demo-app` as its workspace folder and `DEBUGGEN_PROVIDER=deterministic` in its environment. (To install the extension into your everyday VS Code instead, package the VSIX as the README describes.) In the Development Host, open the **Debug Generator** container in the Activity Bar; it holds two views, **Session** and **Sessions**.

You should see: the **Session** view, whose status row reports **Service** as connected and names the active **Provider**.

**Chrome** (153 or later). Open `chrome://extensions`, switch **Developer mode** on, choose **Load unpacked** and select `apps/chrome-extension/dist`.

You should see: a **Debug Generator** card, enabled, whose **Inspect views** line lists a running `service worker`.

### Step 5 — Start the demo with instrumentation attached

> **This step decides whether server and database spans exist at all.** Server-tier telemetry (incoming requests, route handlers, outgoing fetches, Prisma and `pg` queries) comes from a Node preload that must be inside the dev-server process before Next.js starts, together with a server-agent credential the service mints for that one process. Only the two routes below provide both.

Either route works:

- **From VS Code:** run **Debug Generator: Launch Dev Server** (`debuggen.launchDevServer`), or press **Launch dev server** in the Session view. The service spawns the workspace folder's `dev` script — the demo's `next dev` — with the preload on `NODE_OPTIONS` and a credential in `DEBUGGEN_TOKEN` that is scoped to this one project and expires when that process exits.
- **From a terminal:** run `pnpm demo:instrumented`. It asks the running service (Step 3) to launch `apps/demo-app` through that same launcher, prints the dev-server URL and pid, and stays in the foreground; Ctrl-C stops the dev server again. Its variant `node scripts/dev-instrumented.mjs --spawn-local` runs the demo's `dev` script in this terminal instead: it requests a server-agent credential scoped to the demo project from the running service, starts the dev server with the preload and that credential in `DEBUGGEN_TOKEN`, and refuses to start without one, so it records server and database spans as well.

`pnpm demo:dev` starts the demo **without** the preload. Browser telemetry is still captured, but no server, route-handler or database span will appear. The session does not fail silently in that case: the progress view reports a `Could not enable Server spans: …` / `Could not enable Database tracing: …` row with the exact relaunch hint.

The demo's `next.config.ts` deliberately keeps Next.js's default `serverExternalPackages`, so `pg` and `@prisma/client` load from `node_modules` at runtime, where the preload can wrap them; the storefront is otherwise a stock App Router project, so the session exercises the same code paths as one against any other project. A project that bundles those packages into its server build yields no database spans.

You should see: `http://localhost:3000` serve the Lumen Supply storefront — header with search and cart, category chips and a grid of product cards.

### Step 6 — Pair Chrome with the service

1. Open `http://localhost:3000` in the Chrome profile that has the extension, open DevTools and select the **Debug Generator** tab (it may sit behind the `»` overflow).
2. If the connection pill reads **Not paired**, press **Pair…**; the dialog **Pair this panel with VS Code** opens.
3. In VS Code run **Debug Generator: Pair Chrome DevTools Panel** (`debuggen.pairChrome`), or press **Pair Chrome DevTools** in the Session view. The view shows an 8-character **Pairing code**: single use, valid for 5 minutes.
4. Type it into the dialog's **Pairing code** field and press **Pair**.

You should see: the pill read **Connected**, and the panel body show **No session yet — start one from the Debug Generator view in VS Code**. Once a session exists, the header names it and its status. The extension keeps the credential it received, so you pair again only after it is revoked — for example by **Debug Generator: Rotate Service Token**.

## 4. Walkthrough 1 — "Why is this button slow?"

The symptom: placing an order takes well over a second, the Network panel shows one slow request, and nothing in the client code explains it.

1. **Get to a real checkout.** The seed leaves the storefront's cart holding 12 lines, so there is a realistic order to place: open the cart from the header and follow **Checkout** (or go to `http://localhost:3000/checkout`). If the cart is empty — an earlier order converted it — re-run `pnpm demo:seed`, or add a dozen products with **Add to cart**; the checkout's cost grows with every line. Fill in the contact and address fields — **Contact name**, **Email**, **Street address**, **City**, **State or region**, **Postal code**, **Country** — and pick a **Shipping method**. Do not place the order yet.

   You should see: the **Place order** button enabled.

2. **Ask the question.** Keep DevTools open on the **Debug Generator** tab. In the VS Code **Session** view, type **Why is this button slow?** into **What do you want to debug?** and press **Ask question**.

   You should see: a session start. The Session view's **Progress** section begins to fill, and the DevTools panel binds to the tab — the header shows the session and its status, the pill stays **Connected**.

3. **Point at the button.** In DevTools, right-click **Place order** on the page and choose **Inspect** so it is selected in the Elements panel, switch back to the **Debug Generator** tab and press **Use selected element**. Or press **Pick element** — in the panel, or in the Session view's **Target** section — and the page highlights the element under the pointer; click **Place order** on the page itself. The picker consumes that click, so the order is not placed, and the button becomes the target. Press **Esc** on the page, or **Pick element** in the panel again, to leave picker mode without picking. Target selection needs a live session, which is why it comes after the question; it is optional, and without it the session works from the question and the page the tab is on.

   You should see: the panel's **Target** show the element and its **Components, nearest first** chain, which includes `CheckoutButton` and `CheckoutForm`, and the Session view's **Target** section show the same element.

4. **Watch the investigation.** The **Progress** section is drawn from `session.progress` events that each stage emits from what it actually found — nothing in it is canned text. Its shape is:

   ```text
   Understanding problem
   Investigating code
   ✓ Found ‹component›
   ✓ Traced ‹event handler›
   ✓ Found ‹API route›
   ✓ Found database dependency

   Preparing instrumentation
   ✓ Browser performance
   ✓ React renders
   ✓ Network tracing
   ✓ Server spans
   ✓ Database tracing

   Ready to capture
   ```

   with one ✓ row per component, handler and route the code graph actually resolved for this project — on this page, expect the checkout components, the form's submit handler and `/api/checkout`. **Relevant files** lists each file with the symbol and the reason it was selected; clicking one opens it. **File modifications** lists every file the plan patched, each with **View diff**. Expect that list to be short: runtime hooks supply interactions, renders, network, server and database spans without touching a file, and a patch is used only to time a named function — for example a service function on the request path.

   You should see: **Ready to capture**, and the **Capture** section say **Reproduce the issue now.**

5. **Capture one click.** Press **Start capture** (panel header, the Session view's **Capture** section, or **Debug Generator: Start Capture**). Click **Place order** once and wait for the order confirmation. Then press **Stop capture**.

   You should see: while capturing, the collapsible live-events pane at the bottom of the panel streaming redacted events, newest first — kinds `interaction`, `render`, `fetch`, `http.server`, `route.handler`, `function`, `db.query` and `http.client` — and the event counter beside the capture button climbing. After you stop, the status moves through **Analyzing** to **Generated**.

6. **Read the generated panel.** The summary at the top separates **Observed** facts (each with evidence chips that select the underlying events) from **Likely cause** hypotheses (each with a confidence badge and a suggested source location). Below it, look for:

   - **`MetricCards`** — `total_duration` split into `frontend_duration`, `backend_duration` and `database_duration`. With the seeded 12-line cart, expect a total of roughly 1.2–1.6 s, almost all of it backend.
   - **`Timeline`** — one lane per tier and one correlated trace: the click, the `fetch` it caused, the server request span, the route handler, the service functions, the SQL, and the outbound calls to the simulated carrier and payment processor.
   - **`FlameChart`** — the route handler's subtree as nested timing, so the widest bars are the time.
   - **`Waterfall`** — the request chain `fetch` → server → database / outbound calls, with relative offsets.
   - **`QueryTable`** — the parameterized statements (literals replaced by `$1` / `?`), each with its duration, execution count and caller.
   - **`SpanTable`** — "slowest operations", sorted by duration.

   The trace has this shape. Durations vary by machine, other statements (reading and claiming the cart, recording the order) sit between these rows, and `function` spans appear only for the named functions the plan chose to time — without one, the statements nest directly under the route handler:

   ```text
   interaction  click "Place order"
     fetch        POST /api/checkout
       http.server  POST /api/checkout
         route.handler  /api/checkout
           function     ‹timed service function›
             db.query     … FROM inventory_movements …   ← one per cart line; the slowest statements
             db.query     … FROM price_rules …           ← one per cart line
             http.client  POST /api/mock/carrier         ≈ 430 ms
             http.client  POST /api/mock/payment         ≈ 120 ms
     render       React commit after the response
   ```

   You should see: one trace in which the browser, server and database tiers nest under the click — the evidence that the time is spent on the server, and where.

7. **Jump to source.** In the `QueryTable` (or on the slowest `db.query` bar of the `Timeline`), click the source chip of the slowest statement.

   You should see: VS Code come to the front with `src/server/services/inventory.service.ts` open, the cursor on the `pool.query` call site and the line highlighted for a moment. The hop runs panel → service worker → service (which refuses any path outside the project root) → VS Code, and VS Code reports back whether it opened the location. If VS Code is not connected to the service, clicking the chip makes the panel hand the location to VS Code through a `vscode://debuggen.debug-generator/open?file=…&line=…&col=…` link instead: Chrome asks to open VS Code, and the link is validated again inside VS Code (no path outside an open workspace folder, symlinks resolved), which always asks **Open ‹file›:‹line›?** before opening anything. A location the service refuses is never handed over that way, and a failure is reported in the panel.

8. **Ask a follow-up.** In the Session view's **Follow-up** section, type **Why did this query run twice?** and press **Ask follow-up**. Progress shows **Evaluating follow-up question**, and one of two things happens:

   - **The stored capture already answers it.** The analysis and the panel are regenerated from that capture and stored as new versions; the panel is replaced by its successor.
   - **It needs more evidence.** The plan is extended additively (nothing already installed is removed), only the new instrumentation is applied, and the session returns to **Ready to capture** with **Reproduce the issue now.** Refill the cart (placing the order converted it; `pnpm demo:seed` restores the 12-line cart), capture another **Place order** click, and the new capture produces the next analysis and panel.

   You should see: an updated panel either way, with the earlier version kept on the session.

## 5. Walkthrough 2 — "Why is this component rendering so many times?"

The symptom: the catalog feels sluggish even when you are doing nothing on it.

1. **Start a new session on the catalog.** End the previous session first ([section 8](#8-end-the-session-and-verify-cleanup)), then open the catalog at `http://localhost:3000/`. In the Session view, ask **Why is this component rendering so many times?**

   You should see: a new session in both surfaces, and **Progress** filling with the catalog components the investigation found.

2. **Point at a product card.** Inspect any product tile in the grid, return to the **Debug Generator** tab and press **Use selected element** (or use **Pick element**).

   You should see: the target chain include `ProductCard` and `CatalogGrid`.

3. **Capture idleness.** When **Ready to capture** appears, press **Start capture** and then do almost nothing for about ten seconds: let the page sit, scroll a little, hover over cards. No clicks are needed — the point is that the page renders while nobody is using it. To see the second half of the problem, type a few characters into the grid's own search field — the one directly above the grid whose placeholder reads _Search the catalog_, not the search box in the site header — without pressing Enter or **Search**. Press **Stop capture**.

   You should see: `render` events streaming into the live-events pane the whole time, including while you were not touching the page.

4. **Read the panel.** Expect:

   - **`MetricCards`** — `render_count`, `unchanged_render_count`, `render_trigger_unknown_count` and `blocking_time`. Unchanged renders (props shallow-equal, own state unchanged and no consumed context changed) and renders whose trigger could not be determined are counted separately; an undeterminable render is never counted as unchanged.
   - **`RenderTable`** — per component: render count, total and average time, the trigger classification (`props`, `state`, `context`, `unchanged`, `unknown`) and the changed-prop keys. `ProductCard` sits at the top, rendering roughly four times a second per visible card with **no changed props** and trigger **`context`**. The renders caused by typing in the search field show trigger **`props`**, with `onSelect` and `onCategorySelect` as the changed keys.
   - **`ComponentTree`** — the owner tree at the end of the capture with per-node render counts, highlighting the components above the render threshold.
   - **`StateTransitionViewer`** — the state transitions behind those renders: component, hook, old value summary, trigger, new value summary.
   - **`EventLog`** — filtered to `render` and `state` events.
   - **`DependencyGraph`** — from the trigger through the provider to its consumers.

5. **Follow a component to its declaration.** Click `ProductCard` in the `RenderTable`.

   You should see: VS Code open `src/components/catalog/ProductCard.tsx` at the component's declaration.

## 6. Walkthrough 3 — "Why are these requests duplicated?"

The symptom: a product page keeps asking the server for the same recommendations.

1. **Start a new session on a product page.** End the previous session, open any product from the catalog, and ask **Why are these requests duplicated?**

   You should see: **Progress** fill with the components and routes the investigation found for this page, then **Ready to capture**.

2. **Capture a page load.** Press **Start capture**, reload the page, wait about five seconds and press **Stop capture**. A reload does not break the capture: the page agent loads again before React, the extension re-arms it, and the same capture continues.

   You should see: repeated `fetch` events for `/api/recommendations?productId=?&limit=?` in the live-events pane — query values are redacted to `?` before anything is stored or shown.

3. **Read the panel.** Expect:

   - **`MetricCards`** — `request_count` and `duplicate_request_count`.
   - **`RequestTable`** — requests grouped by method, redacted URL, status and duration; the recommendations group is badged with a duplicate count of at least 2, and in practice far more. Expanding it lists every occurrence with its initiator source link.
   - **`Timeline`** — the requests laid against the renders that issued them, so the cadence of the duplicates matches the cadence of the renders.
   - **`RenderTable`** — the initiating component, `RecommendationsRail`, rendering from two places.

   Duplicate detection never needs a raw URL: every request gets a keyed hash (HMAC-SHA-256 with a per-session key) of its method, path and sorted query pairs, computed before redaction, so byte-identical requests collide while requests that differ only in a parameter value stay apart. The details are in [SECURITY.md](SECURITY.md#33-the-pre-redaction-request-key).

## 7. How the three panels differ

Each panel is composed from the component catalog for its question; none is a template.

| Question                                         | Visualization nodes                                                                                                                                                                                             | Summary emphasis                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| "Why is this button slow?"                       | `MetricCards` (total, frontend, backend, database duration), `Timeline`, `FlameChart`, `Waterfall`, `QueryTable`, `SpanTable`, `SourceLink`                                                                     | Observed: where the time went, per tier. Likely cause: the slowest spans, with suggested locations.                                            |
| "Why is this component rendering so many times?" | `MetricCards` (`render_count`, `unchanged_render_count`, `render_trigger_unknown_count`, `blocking_time`), `RenderTable`, `ComponentTree`, `StateTransitionViewer`, `EventLog`, `DependencyGraph`, `SourceLink` | Observed: render counts, renders with unchanged props, the triggering context or state. Likely cause: the provider value or callback identity. |
| "Why are these requests duplicated?"             | `MetricCards` (`request_count`, `duplicate_request_count`), `RequestTable`, `Timeline`, `RenderTable`, `SourceLink`                                                                                             | Observed: identical requests within a window and their initiators. Likely cause: effect dependency identity or a double mount.                 |

The load-bearing fact: the first two panels share only the summary header, the metric cards and the source chips — their visualization bodies are disjoint. `tests/e2e/demo-excessive-renders.spec.ts` asserts that the node-type sets generated for the two questions differ, which is the evidence that panels are generated from the question and the capture, not picked from a set of templates.

## 8. End the session and verify cleanup

1. **End it.** Press **End session** in the Session view's **Session cleanup** section, or run **Debug Generator: End Session** (`debuggen.endSession`). Progress shows **Removing instrumentation**.

   You should see: the cleanup badge read **Clean** — "Every file the session changed was restored to its original content." — with every entry in **File modifications** marked **Reverted**, the DevTools panel show the session as ended, and the storefront keep serving pages.

2. **Check it yourself.** From the repository root:

   ```bash
   git status --porcelain apps/demo-app
   pnpm check:no-residual-instrumentation
   ```

   You should see: no output from `git status` (the demo's tracked files are exactly as committed — the session's database, backups and index cache live under `$DEBUGGEN_HOME`, outside the checkout), and the residual-instrumentation check pass: no instrumentation marker in the demo's tracked source and a clean demo worktree.

**The conflict path is a feature, not a failure.** Edit a file while the session has it instrumented — add a line to a patched service function, say — and the service notices: both surfaces report "‹file› was edited while instrumented. Debug Generator will not overwrite it. Original saved at ‹backup path›." with an **Open diff** action. The file is marked as a conflict and is **not** overwritten at cleanup; its pristine original stays in the backup directory under `$DEBUGGEN_HOME/backups/`, and the session's cleanup status becomes **Conflict** ("Files edited while instrumented were left untouched, so your edits are kept."). Every other file is still restored.

The path in that message is the pristine original — the file as it was before the session first instrumented it. When a follow-up instrumented the same file again, it is the first plan version's backup (the chain root's), never a later one that still carries the instrumentation, so copying it back over the file (or checking the file out with `git checkout -- <file>`) is safe, and so is **Open diff**, which only shows your edit. Once the file matches that original again, end the session — or, if it has already ended, restart the service — and cleanup closes the conflict without writing to the file; `git status --porcelain apps/demo-app` is empty again.

Runtime hooks are disabled at the end of a session, not merely idled: the page agent detaches its listeners and restores the original `fetch` and XHR, and the Node preload unwraps the `pg` and Prisma instrumentation and unregisters the tracer provider, so no span is even created. The inert preload module stays loaded in the dev server you launched; restart the dev server without the tool (`pnpm demo:dev`) for a process with no trace of it. The guarantees and their limits are set out in [SECURITY.md](SECURITY.md#6-generated-instrumentation-risks-and-reversibility-guarantees).

## 9. The seeded defects

These three defects were planted deliberately in `apps/demo-app` so the walkthroughs have something real to find. **This is the only document that records where they are and how they work.** The end-to-end acceptance suite under `tests/e2e/` asserts against them at run time; no product source, prompt, template or repository tooling records where they are or how they work. The product has no knowledge of them: it discovers them through code analysis, instrumentation, telemetry and analysis, never from a hardcoded hint. `scripts/check-no-hardcoding.mjs` enforces that — it derives its forbidden-token list from the demo's own code index and fails the build if any of these identifiers or routes appears in product source, prompts, templates or repository tooling, or if repository tooling names one of the demo's files by path or pins one with a glob — and `tests/e2e/generalization.spec.ts` runs the same workflow against `tests/fixtures/sample-next-app`, which shares no symbol names with the demo.

Paths below are relative to `apps/demo-app/`.

### Defect 1 — slow multi-tier interaction

**Files:** `src/components/checkout/CheckoutButton.tsx`, `app/api/checkout/route.ts`, `src/server/services/checkout.service.ts`, `src/server/services/inventory.service.ts`, `src/server/services/pricing.service.ts`, `src/server/services/shipping.service.ts`, `prisma/migrations/0001_init/migration.sql`.

**Mechanism:** `CheckoutButton` is a plain submit button, and `POST /api/checkout` only validates the request and calls `placeOrder`. The checkout attempt then awaits, strictly in sequence:

1. `reserveStock` (`inventory.service.ts`) — for **each cart line**, a raw `pool.query` whose five CTEs aggregate `inventory_movements` for that product (over the last 540 days, and the last 30 for holds and shipments). The table is indexed only on `warehouse_id`: the initial migration deliberately has **no index on `(product_id, created_at)`**, and the later `0002_cart_checkout_key` migration does not add one either (it only touches `carts`), so each of those aggregates scans the whole 200 000-row ledger.
2. `applyPromotions` (`pricing.service.ts`) — a separate `prisma.priceRule.findMany` **per cart line**: an N+1.
3. `quote` (`shipping.service.ts`) — an HTTP call to the simulated carrier at `POST /api/mock/carrier`, which takes about 430 ms, awaited after the stock and pricing work although it depends on neither.
4. `authorize` — the simulated payment processor at `POST /api/mock/payment`, about 120 ms.

**Observable symptom:** **Place order** takes around 1.2–1.6 s with the seeded 12-line cart, and the time grows with every line because steps 1 and 2 run once per line (measured at the `POST /api/checkout` boundary against the seeded database: about 0.6 s for one line, 1.2 s for twelve; your machine will differ). The Network panel shows a single slow `POST /api/checkout`, and nothing in the client code explains it — the button's own handler is trivial.

**Why it survives code review:** each service function is short and reads correctly in isolation; the awaits look like the natural order of a checkout; a missing index is invisible in application code; and the cost only appears at seeded data volume.

### Defect 2 — excessive renders

**Files:** `src/providers/CartProvider.tsx`, `src/providers/ShippingEtaProvider.tsx`, `src/components/catalog/CatalogGrid.tsx`, `src/components/catalog/ProductCard.tsx`, `src/hooks/useCartSummary.ts`.

**Mechanism:** `ShippingEtaProvider` updates its state on a 250 ms interval (`DISPATCH_ETA_TICK_MS`) to keep the dispatch countdown current, and publishes a new dispatch-ETA context value each time. `CartProvider` consumes that context and builds a fresh `value` object on every render without memoizing it, so the cart context changes four times a second whether or not the cart did. `ProductCard` is wrapped in `memo`, but it reads the cart context through `useCart()`, so all 48 cards of a catalog page re-render on every tick; and `CatalogGrid` passes each card inline `onSelect` and `onCategorySelect` lambdas, so every render of the grid itself (each keystroke in the catalog search, for one) defeats the memoization too. `useCartSummary` memoizes on the whole cart object, which is new every tick, so its memo never hits either.

**Observable symptom:** the catalog feels sluggish while idle. The `RenderTable` shows `ProductCard` rendering hundreds of times per minute with unchanged props and trigger `context`, driven by the ETA tick.

**Why it survives code review:** every piece is idiomatic React — a context provider, a ticking countdown, a memoized card, a summary hook with `useMemo` — and the cost comes from how they interact, which is only visible at runtime.

### Defect 3 — duplicate requests

**Files:** `src/hooks/useRecommendations.ts`, `src/components/product/RecommendationsRail.tsx`, `app/products/[slug]/page.tsx`, `src/components/layout/SiteHeader.tsx`.

**Mechanism:** `useRecommendations(options)` keys its fetch effect on `[options]`, and `RecommendationsRail` calls it with an inline `{ productId, limit }` object, so every render of the rail creates a new identity and refetches. The rail is also mounted twice on a product page: once in the page body (`variant="detail"`) and once as the header's compact mini-rail in `SiteHeader` (`variant="compact"`). `SiteHeader` reads `useCartSummary()`, so defect 2's ticker re-renders the header — and the mini-rail with it — four times a second.

**Observable symptom:** `GET /api/recommendations?productId=…` repeats identically within a short window. The `RequestTable` shows a duplicate count far above 2, and the occurrences come from two mounts of `RecommendationsRail`.

**Why it survives code review:** the hook's dependency array looks complete, the double mount is two independent, reasonable-looking uses in different components, and neither file is wrong on its own.

### Where each defect is exercised

| Defect                             | Walkthrough                                                                  | Automated test                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1 — slow multi-tier interaction    | [section 4](#4-walkthrough-1--why-is-this-button-slow)                       | `tests/e2e/demo-slow-interaction.spec.ts`                      |
| 2 — excessive renders              | [section 5](#5-walkthrough-2--why-is-this-component-rendering-so-many-times) | `tests/e2e/demo-excessive-renders.spec.ts`                     |
| 3 — duplicate requests             | [section 6](#6-walkthrough-3--why-are-these-requests-duplicated)             | `tests/e2e/demo-duplicate-requests.spec.ts`                    |
| Instrumentation removed afterwards | [section 8](#8-end-the-session-and-verify-cleanup)                           | `tests/e2e/cleanup.spec.ts`                                    |
| None of it hardcoded               | —                                                                            | `tests/e2e/generalization.spec.ts`, `pnpm check:no-hardcoding` |

## 10. If something doesn't line up

General troubleshooting (ports, Node and pnpm versions, Docker) is in the [README](../README.md); these are the walkthrough-specific cases.

- **No server or database spans** — the dev server was started without the preload; stop it and relaunch with **Debug Generator: Launch Dev Server** or `pnpm demo:instrumented`.
- **The pill says Not paired** — run **Debug Generator: Pair Chrome DevTools Panel** and enter the code ([Step 6](#step-6--pair-chrome-with-the-service)).
- **The pill says Service not running** — start the service ([Step 3](#step-3--local-service)).
- **Progress asks you to reload the page** ("Reload the page so the Debug Generator hook is in place before React loads.") — the tab was open before the extension loaded; accept the reload.
- **"No telemetry was captured."** — interact with the page while capture is running, then **Capture again**.
- **A "Fallback view" banner on the panel** — the model's panel specification failed validation, so the service built a deterministic panel from the captured data instead; the captured evidence is unchanged.
- **The checkout query looks fast** — the seed did not complete; re-run `pnpm demo:seed`.
- **Pick element reports the panel is not bound to a session** — ask the question in VS Code first; targets attach to a live session.

## 11. Running the same flow automatically

The Playwright suites run this script unattended with `DEBUGGEN_PROVIDER=deterministic`, the same pipeline and no model account. `pnpm install` does not download a browser, so install Playwright's Chromium and the operating-system libraries it needs once per machine first — the same step CI runs (`--with-deps` uses the system package manager and may ask for `sudo` on Linux; drop it when those libraries are already present):

```bash
pnpm exec playwright install --with-deps chromium   # once per machine
pnpm test:browser
pnpm test:e2e
```

`pnpm test:browser` (Playwright project `browser`) loads the built Chrome extension into Chromium and covers the connection, telemetry capture, panel rendering and source navigation against the fixture app. `pnpm test:e2e` (project `e2e`) needs PostgreSQL (Step 1 and Step 2) and the built extension; it launches the demo through the product's own launcher and drives the walkthroughs:

| Spec in `tests/e2e/`              | What it asserts                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `demo-slow-interaction.spec.ts`   | Walkthrough 1: an `interaction` event, a correlated `http.server` span and a `db.query` span in one trace with correct parent/child nesting, and a panel with a `timeline`, a `flame` or `waterfall`, and a `queryTable` |
| `demo-excessive-renders.spec.ts`  | Walkthrough 2: render counts, and a node-type set that differs from walkthrough 1's                                                                                                                                      |
| `demo-duplicate-requests.spec.ts` | Walkthrough 3: a duplicate request group with a count of at least 2                                                                                                                                                      |
| `cleanup.spec.ts`                 | Section 8: every instrumented file byte-identical afterwards, a clean `git status` for `apps/demo-app`, and the demo still serving                                                                                       |
| `generalization.spec.ts`          | The slow-interaction workflow against `tests/fixtures/sample-next-app`, which shares no demo symbol names                                                                                                                |
