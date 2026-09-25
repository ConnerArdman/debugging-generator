# Security and privacy

This is the authoritative description of what Debug Generator can see, change and send, and of the control that governs each. The root [`SECURITY.md`](../SECURITY.md) points here, [`ARCHITECTURE.md`](ARCHITECTURE.md) summarises the access boundary and defers to this document, and [`README.md`](../README.md) covers installation and configuration, which this document does not repeat. Every guarantee below names the file that enforces it; where this document and that file disagree, the file is right and this document has a defect worth reporting ([section 11](#11-reporting-a-vulnerability)).

## Contents

1. [Scope and threat model](#1-scope-and-threat-model)
2. [What is captured, and what is never captured](#2-what-is-captured-and-what-is-never-captured)
3. [Redaction](#3-redaction)
4. [What may leave the machine, and when](#4-what-may-leave-the-machine-and-when)
5. [Model provider boundary](#5-model-provider-boundary)
6. [Generated instrumentation: risks and reversibility guarantees](#6-generated-instrumentation-risks-and-reversibility-guarantees)
7. [Local service access boundary](#7-local-service-access-boundary)
8. [Session data at rest](#8-session-data-at-rest)
9. [Extension permissions](#9-extension-permissions)
10. [Secrets handling](#10-secrets-handling)
11. [Reporting a vulnerability](#11-reporting-a-vulnerability)

## 1. Scope and threat model

### 1.1 Assets

Debug Generator touches three things a developer cares about. It **writes to their source tree**: a small number of named functions are temporarily wrapped so their execution can be timed. It **reads their application's runtime data**: interactions, React renders, requests, server spans and database queries from the app being debugged, plus the project's source code for indexing. And it **may send data off the machine**: when a model provider is configured, the provider credential authenticates requests that carry redacted, bounded excerpts and aggregates. This document covers all three, together with the credentials and local state the product itself creates.

### 1.2 Trust assumptions

- Every component runs as the developer's own OS user on their own machine: the VS Code extension, the local service (`apps/local-service`), the Chrome extension, and the Node preload inside the developer's dev server.
- The service binds to loopback (`DEBUGGEN_HOST`, `127.0.0.1` by default). **Loopback is not an authorization boundary.** It keeps other machines out, but any other process on the machine and any web page the developer visits can open a connection to a loopback port. That is why every client authenticates with a role-bound credential and every web origin is refused ([section 7](#7-local-service-access-boundary)).
- Everything a page produces is untrusted input. The page under debug shares a JavaScript realm with the telemetry agent, so the service validates, bounds and redacts every event it receives, and treats a source location arriving from the panel as hostile until it is proven to lie inside the project ([section 6.5](#65-source-open-containment)).
- The model provider is a third party. What it receives is bounded and redacted ([section 4](#4-what-may-leave-the-machine-and-when)); nothing it returns is executed ([section 5](#5-model-provider-boundary)).

### 1.3 Adversaries considered

| Adversary                                       | What it can attempt                                                               | Primary control                                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A web page open in the developer's browser      | Reach the loopback service with `fetch` or a WebSocket; trigger a `vscode://` URI | Origin policy, no CORS grant and bearer credentials ([section 7](#7-local-service-access-boundary)); independent URI-handler validation and a modal confirmation ([section 6.5](#65-source-open-containment)) |
| A script on the local app origin being debugged | Forge frames between the page agent and the bridge; feed misleading telemetry     | A per-document channel secret minted by the agent at `document_start` (`packages/telemetry/src/browser/transport.ts`); ingest validation, bounds and redaction                                                |
| A local process that cannot read your files     | Call the service; brute-force pairing                                             | Bearer credentials on every route; single-use pairing codes with per-origin and global lockout                                                                                                                |
| Another OS user on the machine                  | Read session data, backups or credentials                                         | `0700` directories and `0600` files, created without following symlinks ([section 8](#8-session-data-at-rest))                                                                                                |
| Model output                                    | Smuggle instructions, code or markup into the product                             | Schema validation, deterministic normalisation, no execution, catalogued components only ([section 5](#5-model-provider-boundary))                                                                            |

### 1.4 Non-goals

These guarantees are **not** offered and should not be inferred:

- no multi-user, team or shared-service model — one developer, one machine;
- no enterprise authentication, single sign-on or central policy;
- no hosted component — nothing of this product runs off the machine, and the only remote party is the model provider, when one is configured;
- no protection against a compromised local user account — a process running as the developer can read `$DEBUGGEN_HOME/auth.json`, the Chrome profile and the project itself, and can send any `Origin` header it likes, so it can do anything the developer can;
- no automatic repair of the bugs the tool finds — it reports observations and likely causes and never edits code to fix them.

## 2. What is captured, and what is never captured

Capture is scoped in time and by plan. The browser agent is **dormant** until the Chrome service worker relays an `agent.config` for a tab bound to a session, and returns to dormant when a later configuration clears every hook. The Node preload admits a span only while a capture is open and only for the signals the plan enabled (`packages/telemetry/src/node/control.ts`). The service drops any batch it cannot attribute to a bound session's open capture before parsing it (`apps/local-service/src/telemetry/attribute.ts`, `ingest.ts`).

### 2.1 Browser tier — the page agent (`packages/telemetry/src/browser/*`)

| Signal                          | What is recorded                                                                                                                                                                                       | Source                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Interactions                    | event type (`pointerdown`, `click`, `keydown`, `submit`, `change`), handler timing from the Event Timing API, target selector and tag, up to 80 characters of scrubbed visible text, React owner chain | `interaction.ts`, `dom-target.ts` |
| React renders and commits       | component display name, phase, duration, render count, changed prop **key names**, trigger classification                                                                                              | `react.ts`, `fiber-diff.ts`       |
| State transitions               | component, hook index, and a type plus 120-character redacted preview of the old and new value                                                                                                         | `state.ts`, `fiber-diff.ts`       |
| Component-tree snapshot         | component names in owner/parent order with per-node render counts                                                                                                                                      | `react.ts`                        |
| `fetch` / XHR metadata          | method, redacted URL, status, size, timing, and the call-site stack (with its URLs' query values masked) for click-to-source                                                                           | `fetch.ts`                        |
| Performance entries, long tasks | `navigation`, `resource`, `paint` and `longtask` entries: names, timings, sizes                                                                                                                        | `perf.ts`                         |
| JavaScript errors               | exceptions, unhandled rejections and resource-load errors: message and stack, scrubbed, stack URLs masked                                                                                              | `errors.ts`                       |

### 2.2 Server tier — Next.js's tracer plus the Node preload (`packages/telemetry/src/node/*`)

| Signal                      | What is recorded                                                                                                                     | Source                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Incoming HTTP requests      | `http.server` spans: method, route, status, timing                                                                                   | Next.js's own tracer, active once `register.ts` installs a tracer provider |
| Route handlers              | `route.handler` spans                                                                                                                | Next.js's own tracer                                                       |
| Outgoing fetch              | `http.client` spans: method, redacted URL, status, timing                                                                            | Next.js's own tracer                                                       |
| Functions the plan selected | `function` spans for the named symbols a plan patched ([section 6](#6-generated-instrumentation-risks-and-reversibility-guarantees)) | `span-helper.ts` behind the patch template                                 |

### 2.3 Database tier

| Signal         | What is recorded                                                        | Source                              |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| Prisma queries | `db.query` spans: parameterised statement text, duration, `db.rowCount` | `@prisma/instrumentation`           |
| `pg` queries   | `db.query` spans: parameterised statement text, duration, `db.rowCount` | `@opentelemetry/instrumentation-pg` |

### 2.4 Never captured

- **Request and response bodies.** Only method, redacted URL, status, size and timing. The fetch/XHR patch reads no body, clones nothing and never reads a header value; the only header it adds is `traceparent`, on same-origin requests (`packages/telemetry/src/browser/fetch.ts`). Any attribute named like a body, payload, result set or parameter list is dropped outright at ingest (`DROPPED_ATTRIBUTE_KEYS` in `packages/telemetry/src/redaction/redactor.ts`).
- **Full React prop and state values.** Props and state are captured as key names plus a type/summary and change flags. Previews are truncated to 120 characters after passing through the same pattern rules as every other value, each object is bounded to 32 keys, and functions and DOM nodes are never serialised (`MAX_PREVIEW_LENGTH` and `MAX_TRACKED_KEYS` in `packages/telemetry/src/schema/attributes.ts`; `packages/telemetry/src/browser/fiber-diff.ts`). Opt-in full values are not implemented.
- **Database row contents.** Only `db.rowCount`.
- **`.env*` files, `DATABASE_URL` and passwords.** The indexer never reads an `.env` or `.env.*` file, a dot-directory, or the generated and vendored trees `node_modules`, `.next`, `dist`, `out`, `build`, `coverage`, `generated` and their kin, and it reads only TypeScript and JavaScript source extensions (`EXCLUDED_DIRECTORY_NAMES`, `INDEXABLE_EXTENSIONS` in `packages/code-analysis/src/project.ts`). A code excerpt can never be taken from an environment file.
- **Keystrokes, form values, clipboard, screenshots and page HTML.** The interaction listener records the event type, never which key was pressed. The element descriptor reads only `id`, `class` and bounded visible text — never `value`, `innerHTML`, `outerHTML` or `data-*` attributes (`packages/telemetry/src/browser/dom-target.ts`). Nothing reads the clipboard or takes a screenshot.

### 2.5 Where captured data goes

After redaction, and only after it, an event is persisted in the local `node:sqlite` store at `$DEBUGGEN_HOME/sessions.sqlite`, streamed to the DevTools live tail (`telemetry.tail`) and aggregated for the generated panel. What of it may reach a model provider is bounded in [section 4](#4-what-may-leave-the-machine-and-when).

## 3. Redaction

### 3.1 Where it runs

Redaction runs at **two pipeline points**, and a third layer protects the logs:

1. **Ingest, before anything is stored or shown.** `apps/local-service/src/telemetry/ingest.ts` runs, for every batch: attribute the batch → parse each event → compute `request_key` ([section 3.3](#33-the-pre-redaction-request-key)) → **redact** (`redactEvent` in `packages/telemetry/src/redaction/redactor.ts`) → stamp session and capture → persist → correlate → live tail. Nothing downstream — the store, the aggregates, the panel data routes, the DevTools panel — ever sees an unredacted value, and an event the redactor cannot process is counted and never stored.
2. **Every outbound prompt payload.** `packages/model-provider/src/redact-guard.ts` re-inspects the whole request and **rejects the call** when a denied pattern survived. It is a guard, not a second redactor: it never rewrites a payload, so a regression upstream fails loudly instead of being hidden. It also **fails closed**: a payload too deep or too large to inspect completely is refused, and a finding names the field path and rule, never the value. The guard runs when the local service builds each stage request (`apps/local-service/src/pipeline/context-builder.ts`, `src/panels/generate.ts`) and again inside the network provider before transport, including on every repair turn (`packages/model-provider/src/providers/anthropic.ts`).
3. **Logs.** `apps/local-service/src/logging.ts` applies pino's path-based `redact` option and then walks every field and message through the same scrub primitives, so a credential inside an error message a library wrote is removed before the record is written.

The redaction functions are pure — no I/O, clock or randomness — and unit-tested per handler (`packages/telemetry/src/redaction/*.test.ts`, `packages/model-provider/src/redact-guard.test.ts`). Attribute **names** are judged as well as values, because a page can use a token as a map key.

### 3.2 Deny list

The rule vocabulary is `sensitive-header`, `provider-key`, `bearer-token`, `jwt`, `private-key`, `connection-string`, `url-query-value` and `entropy` (`REDACTION_RULE_IDS` in `packages/telemetry/src/redaction/rules.ts`). The literal patterns live in exactly two places — `packages/telemetry/src/redaction/rules.ts` for runtime redaction and `scripts/check-secrets.mjs` for the repository gate — and both assemble them from fragments so that neither file contains a matchable secret; this document names them rather than repeating them.

| Data                                                                                                                                                                     | Treatment                                                                                                                                                                              | Handler                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Headers `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `proxy-authorization`                                                                      | value replaced with `[redacted]`; the header's presence is retained                                                                                                                    | `headers.ts` (`DENIED_HEADER_NAMES`)           |
| Values under a key-like name (containing `key`, `token`, `secret`, `password`, `passwd`, `pwd`, `credential` or `auth`, in any case or separator style)                  | replaced whole with `[redacted]`, however short — a four-character password is still a password                                                                                        | `rules.ts` (`scrubNamedValue`)                 |
| Provider credentials: Anthropic API-key prefixes, OpenAI-style secret-key prefixes, GitHub personal-access-token prefixes (classic and fine-grained), AWS access-key ids | pattern-replaced anywhere in any attribute, including the whole run of credential characters after the prefix                                                                          | `rules.ts`                                     |
| Bearer credentials, JWT-shaped strings, PEM private-key blocks                                                                                                           | pattern-replaced anywhere; the `Bearer` scheme word survives so presence stays visible                                                                                                 | `rules.ts`                                     |
| Connection strings with embedded credentials                                                                                                                             | the user-and-password part of the URL is replaced; scheme and host survive                                                                                                             | `rules.ts`                                     |
| URL query-parameter **values**                                                                                                                                           | each value replaced with `?` per key, for display and storage; path and parameter names retained; applied to URLs inside stack traces too                                              | `url.ts`                                       |
| Request and response bodies, result sets, parameter lists                                                                                                                | never captured; an attribute carrying one is dropped                                                                                                                                   | `redactor.ts` (`DROPPED_ATTRIBUTE_KEYS`)       |
| SQL                                                                                                                                                                      | `db.statement` stored as parameterised text: `$1`-style placeholders kept, every inline literal (string, number, hex, dollar-quoted body) replaced by `?`; row contents never captured | `sql.ts`                                       |
| React props and state                                                                                                                                                    | key names plus type/summary and change flags; 120-character previews scrubbed by the same rules before truncation; at most 32 keys per object                                          | `packages/telemetry/src/browser/fiber-diff.ts` |
| Any single value                                                                                                                                                         | scanned up to 16,384 characters; an unscanned tail is replaced, never passed through                                                                                                   | `rules.ts` (`MAX_SCAN_LENGTH`)                 |

### 3.3 The pre-redaction request key

Duplicate-request detection is the one place raw URL data is used, and it is used exactly once. Redaction stores `?id=A` and `?id=B` identically as `?id=?`, so grouping by the stored URL would report two distinct requests as a duplicate. `packages/telemetry/src/redaction/request-key.ts` therefore computes, at ingest and **before** redaction:

```text
request_key = HMAC-SHA-256(sessionKey, version + method + path + sorted query pairs)
```

The input is the unredacted URL; the key is 32 random bytes generated per session and held only in the store's `session_keys` table, never sent anywhere. Byte-identical requests collide, so genuine duplicates are detected; requests that differ only in a parameter value do not, so distinct requests are never merged. The raw URL is never stored or displayed, the digest is opaque — the material it was computed over cannot be recovered from it — and the session key is deleted with its session. `packages/telemetry/src/aggregate/requests.ts` groups by `request_key`, and `request-key.test.ts` pins both the duplicate and the distinct-parameter cases.

### 3.4 Residual risk

Pattern-based redaction is best-effort against data the application itself places in URL paths, header names, span names, error messages, element text or SQL identifiers: a customer email in a path segment, for example, is not a pattern this layer recognises. The mitigations are structural rather than pattern-based — bodies, row contents, input values and full prop/state values are never read at all, every preview is bounded, and the outbound guard fails closed. For a codebase whose runtime data must not leave the machine under any circumstances, run with `DEBUGGEN_PROVIDER=deterministic` ([section 4](#4-what-may-leave-the-machine-and-when)).

## 4. What may leave the machine, and when

**Nothing leaves the machine unless the `anthropic` provider is selected and both `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL` are set; nothing leaves at all with `DEBUGGEN_PROVIDER=deterministic`.** The deterministic provider is rules-based and imports no model SDK, opens no socket, reads no environment variable and touches no file (`packages/model-provider/src/providers/deterministic.ts`). With `anthropic` selected but either variable missing, the service reports a configuration failure before any call is attempted (`packages/model-provider/src/factory.ts`).

Know which provider is in effect. The service's own default is `deterministic` (`DEFAULT_PROVIDER_ID` in `factory.ts`, and `.env.example`). When the VS Code extension starts the bundled service, it forwards its `debuggen.provider` setting as `DEBUGGEN_PROVIDER`, and that setting defaults to `anthropic` with `machine-overridable` scope, so a workspace's own settings can also set it (`apps/vscode-extension/package.json`). Set it to `deterministic` to keep a session entirely local, and review the `.vscode/settings.json` of a repository you do not trust.

When a provider is configured, each stage sends only the following, after the caps in `apps/local-service/src/pipeline/context-builder.ts` and the outbound guard of [section 3.1](#31-where-it-runs):

| Stage                    | What is sent                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Problem understanding    | the developer's question (in the prompt text only); the selected target descriptor (selector, tag, up to 80 characters of scrubbed text, component chain, URL); the current URL, redacted; the project summary from `packages/code-analysis/src/summary.ts`                                                                                |
| Code investigation       | the understanding, and the results of read-only code-graph queries the model proposes and deterministic code executes: names, file paths, relations and **bounded excerpts of only the files the investigation selected** (at most 40 lines and 4,000 characters each, `CODE_QUERY_LIMITS` in `packages/code-analysis/src/graph/query.ts`) |
| Instrumentation planning | the understanding, the investigation and the adapters' capability catalog                                                                                                                                                                                                                                                                  |
| Analysis                 | aggregate telemetry statistics — trace trees, top spans, render statistics, request and query groups — with redacted span attributes and the relevant bounded excerpts                                                                                                                                                                     |
| Panel generation         | the validated analysis result and the panel node catalog                                                                                                                                                                                                                                                                                   |
| Follow-up                | the prior understanding, plan, capture summary, analysis and panel, and the new question                                                                                                                                                                                                                                                   |

Not sent, even with a provider configured: no repository dump or bulk upload (the investigation stage proposes graph queries; it never receives the tree); no `.env*` content; no request or response bodies; no database rows; no full prop or state values; and no payload that failed the outbound guard. A credential a developer hard-coded in a source file is not rewritten out of an excerpt: the guard refuses the whole call and the stage fails with a finding that names the field, so a secret in source makes a stage fail rather than leak.

The egress path is `packages/model-provider/src/providers/anthropic.ts`, which calls the Anthropic API over HTTPS through `@anthropic-ai/sdk`, authenticated with `ANTHROPIC_API_KEY` read from the service's environment. The model id comes from `DEBUGGEN_MODEL` and is never hardcoded or defaulted, so a session's record of the model it used is always true. What was sent is auditable after the fact: prompts are versioned files and the versions used are recorded on the session ([section 5](#5-model-provider-boundary)).

## 5. Model provider boundary

**One interface, two implementations.** `ModelProvider` (`packages/model-provider/src/provider.ts`) has a network-backed implementation, `providers/anthropic.ts`, and a rules-based one, `providers/deterministic.ts`, which builds schema-valid outputs from the structured inputs — code-graph candidates and capture aggregates — and never reads the rendered prompt or the question's wording. `factory.ts` selects between them from `DEBUGGEN_PROVIDER`. Every automated test uses the deterministic provider, and **no recorded model responses are shipped** anywhere in the repository.

**Prompts are versioned, auditable files.** Each stage's prompt is a repository file, `apps/local-service/prompts/<stage>/vNNN.md`, treated as immutable once committed: a change is a new version file plus an update to `prompts/manifest.json`, which selects the current version per stage. `packages/model-provider/src/prompt-loader.ts` loads by stage and version, and the versions used are recorded on the session (`promptVersions` in `packages/protocol/src/session-record.ts`). No prompt strings live in modules, so what a session asked a model is reconstructible from the repository and the session record, and a prompt change is always a reviewed diff.

**The model cannot act.** It produces data, and that data is schema-validated before it can affect anything:

- The only code that writes to the developer's project is `packages/instrumentation/src/patch/patcher.ts` and `packages/instrumentation/src/cleanup.ts`, invoked by `apps/local-service/src/instrumentation/service.ts` with a validated, normalised plan whose actions have passed the feasibility check against the code graph (`packages/instrumentation/src/feasibility.ts`).
- The investigation stage's "tools" are read-only code-graph queries executed by `apps/local-service/src/pipeline/tools/code-tools.ts`; the model proposes, deterministic code executes.
- No model output is evaluated, executed or rendered as markup. A generated panel composes only components registered in the node catalog (`packages/panel-schema/src/catalog.ts`, `packages/panel-renderer/src/host/registry.ts`); an unknown node type fails validation before rendering, and all model text is rendered as text.

**Validation, then safe fallbacks.** Output is parsed against the stage's authoring schema with at most two repair re-prompts (`DEFAULT_MAX_REPAIRS`, `packages/model-provider/src/structured.ts`), then passed through deterministic normalisation and the internal schema; a failure there is a rejection, never retried against the model. A rejected plan falls back to a runtime-only default plan built from the adapters' capabilities (`apps/local-service/src/pipeline/stages/plan.ts`), which patches no file. A rejected panel falls back to a deterministic panel assembled from the capture aggregates (`apps/local-service/src/panels/fallback.ts`), flagged `meta.fallback` and shown under the banner "Generated panel failed validation; showing a fallback view built from captured data." Observed facts must cite evidence that exists in the capture (`packages/panel-schema/src/semantic.ts`). A session reaches `generated` only after a validated analysis and a validated panel exist (`apps/local-service/src/sessions/state-machine.ts`), so a failure is never presented as a successful analysis.

## 6. Generated instrumentation: risks and reversibility guarantees

### 6.1 The risk

This product **edits files in the developer's working tree.** When a plan asks for the timing of a named function — the one signal runtime hooks cannot supply — that function's body is moved into an inner function and wrapped with a call to a span helper (`packages/instrumentation/src/patch/function-timing.ts`, `wrap-template.ts`). Three things could go wrong, and each has a specific mitigation:

| What could go wrong                                                  | Mitigation                                                                                                                                                                                              | Enforced by                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| An edit is left behind after a session, a crash or an editor restart | every edit is journalled before it is written, and cleanup reconciles every open record on end, on editor deactivation and on service start                                                             | `packages/instrumentation/src/patch/patcher.ts`, `apps/local-service/src/cleanup/cleanup.ts`          |
| An edit collides with the developer's own change to the same file    | a file whose bytes differ from what the tool wrote is never modified; it is reported as a conflict                                                                                                      | `apps/local-service/src/instrumentation/watcher.ts`, `packages/instrumentation/src/patch/conflict.ts` |
| The process dies between taking the backup and writing the file      | the journal records both the original and the expected post-write hash before the write, so reconciliation can always tell "never written", "written but unmarked" and "changed by the developer" apart | `patcher.ts`, `patcher.test.ts` (failure injected at every boundary)                                  |

### 6.2 The guarantees

- **Runtime first.** Patches are used only for `function-timing` and `server-span` actions on named symbols. Every other signal — interactions, renders, requests, performance, errors, server request and route spans, database queries — comes from a runtime hook that touches no file ([section 2](#2-what-is-captured-and-what-is-never-captured)).
- **Original content and hash recorded before any edit.** `patcher.ts` resolves the target inside the project root lexically and then on the filesystem and pins its directory, so a symlink cannot redirect the write outside the project; computes `originalHash` and, from the in-memory patch, `instrumentedHash`; copies the original bytes to `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` (mode `0600`) and `fsync`s it (`backup-store.ts`); journals a `ModificationRecord` as `pending` with both hashes, the backup path and the unified diff; and only then writes a temp file, `fsync`s it, re-checks the target and renames it into place atomically, preserving the file's mode.
- **Every modification is visible.** Each record appears in the VS Code modifications list with its diff (`ModificationsList`, `DiffView`), in the DevTools session summary (`SessionSummary`), in the `instrumentation.ready` message, and at `GET /sessions/:id/modifications`.
- **Cleanup is reliable.** `apps/local-service/src/cleanup/cleanup.ts` runs on `session.end`, on VS Code deactivation (which ends the active session over the same route) and as reconciliation on service start — for every non-reverted record, whatever its session's status. Restoration happens strictly in reverse order along follow-up chains, a restored file's hash is verified against `originalHash`, and only then is its backup deleted.
- **Conflicting developer edits are detected, never overwritten.** `watcher.ts` moves a record whose file stops matching `instrumentedHash` to `conflict` and tells both UIs: "‹file› was edited while instrumented. Debug Generator will not overwrite it. Original saved at ‹backup path›." At cleanup, `conflict.ts` authorises a write only when the file still matches what the tool wrote; any other state leaves the file untouched, keeps the original in the backup directory and reports the conflict with diffs, and the session's cleanup status becomes `conflict`.
- **No bookkeeping inside the project.** The session database, backups and index caches live under `$DEBUGGEN_HOME` (default `~/.debuggen`), so a session never changes the project's `git status` beyond the patched files themselves.
- **Teardown disables rather than idles.** When a capture ends, the browser agent returns to dormant: listeners detached, `fetch` and `XMLHttpRequest` restored to the original functions, React hooks unsubscribed. The Node preload stops creating spans at all (a sampler decision, so no span object is even constructed), calls `disable()` on the pg and Prisma instrumentations, and disables the global tracer provider and propagator so Next.js's own spans become no-ops (`packages/telemetry/src/node/control.ts`; `control.test.ts` asserts zero `onStart` calls after disable).
- **Enforced in CI.** `pnpm check:no-residual-instrumentation` (`scripts/check-no-residual-instrumentation.mjs`) fails when an instrumentation marker appears in the demo application's tracked source or its working tree is dirty; `tests/e2e/cleanup.spec.ts` asserts every instrumented file is byte-identical to its pre-session content and that the application keeps serving.

**What remains after cleanup.** An inert preload module stays loaded in the dev-server process — no active patches, no tracer provider and no file changes — and the application keeps serving. A fully instrumentation-free process is restored by **restarting the dev server without the tool**.

### 6.3 Changes to the running application

While a capture is armed, the page agent patches `window.fetch` and `XMLHttpRequest` to add a W3C `traceparent` header to **same-origin** requests only, so no trace context reaches a third-party origin (`packages/telemetry/src/browser/fetch.ts`). It adds no other header, reads no header value or body, returns the same `Response` instance and rethrows the same errors, and on any internal failure calls the original function unchanged. The page's own error handlers are never replaced (`packages/telemetry/src/browser/errors.ts`).

### 6.4 The launched dev server

The service can start the project's dev server itself (`apps/local-service/src/dev-server/launcher.ts`), spawning it without a shell on POSIX, appending the preload to `NODE_OPTIONS` and injecting `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and `DEBUGGEN_PROJECT_ROOT`. The child's output is scrubbed of the token before it is logged or buffered, and the credential is revoked when the child exits ([section 7](#7-local-service-access-boundary)). Without a valid credential the preload stays inert.

### 6.5 Source-open containment

Click-to-source crosses two independent containment checks, because the path a panel sends is data from a browser tab:

- **The service.** `apps/local-service/src/source/open.ts` validates the `source.open` frame, looks up the session, checks that the requesting principal may act on it, and proves — lexically and on the filesystem — that the file lies inside the session's `projectRoot` before forwarding the location to the session's VS Code client.
- **The `vscode://` fallback.** Any web page can trigger a `vscode://` URI, so `apps/vscode-extension/src/uri-handler.ts` trusts nothing, including the service: it requires exactly one each of `file`, `line` and `col`; refuses traversal, absolute, drive-lettered, UNC, backslash and `~` paths; range-checks line and column; resolves both the workspace folder and the file with `fs.realpath` and requires the file to stay inside an open folder (a symlink that escapes is refused) and to be a regular file; allows one pending dialog at a time; asks the developer to confirm "Open ‹file›:‹line›?" in a modal dialog; and re-validates after the answer before opening. `apps/vscode-extension/test/suite/uri-handler.test.ts` asserts that a file outside the workspace or a traversal path opens nothing.

## 7. Local service access boundary

Binding to `127.0.0.1` keeps other machines out, not other local processes or web pages, so the service authenticates every client, binds every credential to a role and a scope, and refuses every web origin. The mechanism is `apps/local-service/src/server/auth.ts`; every route and socket consumes its decisions.

### 7.1 Three role-bound credentials

Each credential is 32 random bytes from a CSPRNG, rendered base64url, and stored **only as its SHA-256 hash** in the `credentials` table together with its role, scope, issue time and optional expiry (`CREDENTIAL_ROLES`, `CREDENTIAL_TOKEN_BYTES`).

| Role           | Scope                                                                                                    | Issued by                                                                                                                                | Plaintext held                                                                                        | Lifetime                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `vscode`       | the machine user; acts only under the workspace folders its live connections announced in `client.hello` | the service on first start                                                                                                               | `$DEBUGGEN_HOME/auth.json` (mode `0600`), read directly by the extension, which runs as the same user | until rotation                                                                                     |
| `devtools`     | the Chrome extension id that redeemed a pairing code                                                     | `POST /pair/complete`                                                                                                                    | that one response, then `chrome.storage.local` (`apps/chrome-extension/src/background/auth.ts`)       | until rotation                                                                                     |
| `server-agent` | exactly one `projectRoot`                                                                                | the dev-server launcher, once per launch; or `POST /dev-server/credential` (editor credential required) for a dev server started by hand | the dev-server process environment, as `DEBUGGEN_TOKEN`                                               | revoked when the launched process exits; a hand-started server's credential expires after 12 hours |

The page agent holds no credential and no socket: the service worker relays its frames under the tab's `devtools` connection, and a `client.hello` claiming to be the page agent is refused.

### 7.2 Presentation

Every HTTP request carries `Authorization: Bearer <token>`. Every WebSocket must send its token in its first frame, `client.hello`, within 3 seconds of the upgrade, or it is closed with code **4401** (`CLIENT_HELLO_TIMEOUT_MS`, `WS_CLOSE_UNAUTHORIZED` in `packages/protocol/src/messages/agent.ts`). The stored role and scope become the request's principal; the `client`, `projectRoot` and `tabId` a hello announces are claims, and where a claim contradicts the credential the connection is refused. Authorization therefore never depends on a client's self-description. Each role may also be presented only from the origin its client can have: an editor credential from no origin or a VS Code webview, a DevTools credential only from `chrome-extension://<the id it was issued to>`, and a server-agent credential only from no origin.

### 7.3 The two unauthenticated operations

- `GET /health` returns `{ version, protocolVersion, pairingAvailable }` and nothing else.
- `POST /pair/complete { code }`, whose one-time code **is** the capability: 8 characters from a CSPRNG over a 32-symbol alphabet without look-alike characters, valid for 5 minutes, redeemable once, stored only as a hash in `pairing_codes`, and rate-limited — 5 consecutive failures from one origin lock that origin out for 60 seconds, and 20 failures across all origins, each within 60 seconds of the last, lock pairing globally for 60 seconds, which bounds a local process that forges extension ids (`PAIRING_*` constants in `auth.ts`).

Both refuse web origins like every other route: the origin policy runs before the exemption check, so "exempt" means "no bearer credential", never "unprotected" (`AUTH_EXEMPT_OPERATIONS` in `packages/protocol/src/http.ts`).

### 7.4 Pairing the Chrome extension

The Chrome extension cannot read `auth.json`, so it pairs (`apps/local-service/src/server/routes/pair.ts`):

1. The VS Code command `debuggen.pairChrome` calls `POST /pair/start` with the editor credential and shows the code.
2. The developer types the code into the DevTools panel's pair dialog.
3. The service worker calls `POST /pair/complete` from its `chrome-extension://<id>` origin and receives a `devtools` credential scoped to that id — taken from the validated `Origin` header, never from the request body — which it stores in `chrome.storage.local`.

A DevTools credential presented from any other origin is rejected.

### 7.5 Origin policy

Any HTTP request or WebSocket upgrade whose `Origin` is an `http:` or `https:` web origin is rejected, as are `file:`, `data:`, `null` and anything unparseable. Accepted origins are exactly three shapes, judged on the parsed URL rather than a prefix: absent (Node clients such as the extension host and the preload), `chrome-extension://<id>` and `vscode-webview://<id>`. **No `Access-Control-Allow-Origin` header is ever set**, so a browser page cannot read any response even if it provokes one, **and** every state-changing route requires a bearer credential, which closes cross-site request forgery. Both halves matter: without the first a page could read responses; without the second a page could still cause effects.

Origin checks constrain browsers, which set `Origin` honestly. A local process can send any header, so against local processes the bearer credential is the control — and a process that can read the developer's files can read that credential ([section 1.4](#14-non-goals)).

### 7.6 Authorization by role and scope

| Role           | May                                                                                                                                                                                 | May not                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `vscode`       | create, question, control and end sessions, launch and stop dev servers, start pairing — for project roots under the workspace folders it announced                                 | act on a project outside those folders                                                    |
| `devtools`     | bind its own tab, select targets, read the session, start and stop capture, query panel data and modifications, and send `source.open` — **only for the session bound to that tab** | create, question or end a session; act on a session bound to another tab; claim a project |
| `server-agent` | post telemetry to `POST /telemetry/ingest` and receive its own `server-agent.config` — only for its scoped project                                                                  | call any session route; ingest for another project                                        |

The operation-to-role table is `OPERATION_ROLES` in `auth.ts`.

### 7.7 Rotation and revocation

The VS Code command `debuggen.rotateServiceToken` rotates everything: in one transaction every credential and outstanding pairing code is deleted, a new editor credential is minted and `auth.json` is rewritten; then every open socket is closed with code 4401 (`AuthService.rotateAll`). Paired Chrome extensions must pair again, and launched dev servers must be relaunched to receive a new server-agent credential. A launched dev server's credential is also revoked on its own the moment the process exits.

`apps/local-service/src/server/auth.test.ts` and `apps/local-service/test/integration/auth.test.ts` pin these rules: unauthenticated and web-origin requests are rejected; a pairing code works once and fails on reuse and after expiry; a DevTools credential cannot create a session or act on a session bound to another tab; a server-agent credential cannot ingest for another project or call session routes; an editor credential cannot act outside its announced workspace; rotation invalidates every existing credential and socket.

## 8. Session data at rest

Everything the product keeps lives under `$DEBUGGEN_HOME` (default `~/.debuggen`), outside every checkout. Treat it as being as sensitive as the projects you debug: it holds diffs and backups of your source.

| Path                                                              | Contents                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions.sqlite` (WAL mode, with its `-wal` and `-shm` sidecars) | sessions and their questions, progress, plans, the modification journal with unified diffs, captures with redacted telemetry, panels, analyses, follow-ups, tab bindings, credential hashes, pairing-code hashes and per-session request-key secrets (`apps/local-service/src/store/schema.sql`) |
| `backups/<sessionId>/<originalHash>`                              | the original bytes of every file the product instrumented                                                                                                                                                                                                                                        |
| `index/`                                                          | the code-index cache for projects you have opened                                                                                                                                                                                                                                                |
| `auth.json`                                                       | the editor credential, in plaintext                                                                                                                                                                                                                                                              |

**Permissions.** The directory tree is created `0700` and every file `0600`. `packages/shared/src/node/safe-fs.ts` creates files with an exclusive, no-follow open after verifying that each parent is a real directory owned by the current user with mode `0700`, and refuses otherwise — including an existing directory that already grants group or other access, which it reports rather than repairs. A symlink planted at a path it is asked to create yields an error instead of being followed (`safe-fs.test.ts`).

**Retention.** `apps/local-service/src/store/retention.ts` runs on service start and on the VS Code command `debuggen.purgeSessions`:

- sessions whose last activity is older than `DEBUGGEN_RETENTION_DAYS` (default 30) are deleted together with their telemetry, panels, analyses, request-key secret and backup directory;
- backup files no journal record references are deleted once they are 7 days old (the gap covers a crash between backup and journal);
- index caches for projects not opened within the retention window are deleted;
- **conflict backups are exempt until the conflict is resolved**, because they may be the only copy of the original file.

Every deletion re-checks that its target lies inside `$DEBUGGEN_HOME` and refuses to follow a symlink.

**Deleting everything.** End every active session so its instrumentation is restored, resolve any reported conflict, then run `debuggen.purgeSessions` or remove `$DEBUGGEN_HOME` entirely. Do not remove it while a session still holds applied modifications or an unresolved conflict: the backups are the record of what the files contained.

## 9. Extension permissions

### 9.1 Chrome extension

Declared in `apps/chrome-extension/manifest.config.ts` and asserted field by field against the built manifest by `apps/chrome-extension/test/manifest.test.ts`:

| Permission or declaration                                                     | Why it is needed                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                                                     | the paired `devtools` credential in `chrome.storage.local`; the tab-to-session bindings in `chrome.storage.session`                                                                         |
| `alarms`                                                                      | a keepalive for the service worker's WebSocket to the service, because Manifest V3 suspends an idle service worker after roughly 30 seconds                                                 |
| `tabs`                                                                        | observing committed navigations to re-arm the agent or unbind the tab, and the reload the developer consents to when a page loaded before the extension                                     |
| `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*`                | the local app origins only — no `https:` origins, no wildcard hosts — which is also what permits a MAIN-world content script on them                                                        |
| `devtools_page`                                                               | contributes the "Debug Generator" panel; element selection evaluates a descriptor of `$0` in the inspected page through `chrome.devtools.inspectedWindow.eval`, only while DevTools is open |
| content script `agent.iife.js`, `world: "MAIN"`, `document_start`             | the telemetry agent; the React DevTools hook must exist before React loads, so it cannot be injected later                                                                                  |
| content script `src/content/bridge.ts`, `world: "ISOLATED"`, `document_start` | the relay between the page agent and the service worker: origin-checked, tagged, size-capped messages                                                                                       |
| module `background.service_worker`                                            | the authenticated WebSocket, the tab-to-session registry and the arming of the agent                                                                                                        |

Both content scripts are top-frame only (`all_frames: false`). Not declared: `scripting` (nothing is registered or injected dynamically), `action` or popup, `options_page`, `externally_connectable` (so no web page can message the extension), `cookies`, `webRequest`, `debugger` and any broad host pattern; the manifest authors no `web_accessible_resources` (the build adds one entry for the bundled bridge chunk).

A MAIN-world script shares the page's JavaScript realm, so the agent is constrained accordingly:

- it runs only on the two local app origins;
- it is **dormant until the service worker sends a configuration for a bound tab** — at `document_start` it only installs the React hook, publishes a disabled helper and opens its channel to the bridge; no capture listener, observer, `fetch` patch or fiber subscription exists until then — and it returns to dormant when the configuration is cleared;
- the only global it exposes is `globalThis.__DEBUGGEN__`: the span helper patched functions call, the element descriptor used for `$0`, and a diagnostic copy of its configuration;
- its channel to the bridge carries a per-document secret the agent mints before any page script runs, so a page script cannot forge an `agent.config` (`packages/telemetry/src/browser/transport.ts`);
- it is byte-identical to the built `packages/telemetry` bundle: `scripts/copy-agent.mjs` copies `packages/telemetry/dist/browser-agent.iife.js` into the extension, and the build verifies the SHA-256 of the emitted file.

### 9.2 VS Code extension

`apps/vscode-extension` activates on its own view (`onView:debuggen.session`), on `onUri` and on its contributed commands. It reads the open workspace folders to determine the project root, starts the service bundled in the extension when none answers `/health` (unless `debuggen.autoStartService` is off), reads `$DEBUGGEN_HOME/auth.json` to authenticate, and opens files at locations with `window.showTextDocument`, subject to the URI-handler validation of [section 6.5](#65-source-open-containment). It sends the editor credential only to `debuggen.serviceUrl` (default `http://127.0.0.1:43117`), a `machine`-scoped setting that a workspace's own settings cannot override; keep it on loopback. On deactivation it ends the active session so cleanup runs.

## 10. Secrets handling

- **Tracked environment files.** Only `.env.example` and `apps/demo-app/.env.example` are tracked, and both hold placeholders or the throwaway local-container credential of the demo database. `.gitignore` excludes every other `.env*` variant, `*.sqlite*`, build output, logs and captured telemetry other than the curated, redacted fixtures under `packages/telemetry/test/fixtures/`.
- **The provider credential.** `ANTHROPIC_API_KEY` is read from the service's environment by `packages/model-provider/src/factory.ts`. It is never written to the store, never logged and never placed in a prompt; error messages name the variable, never its value.
- **Service credentials.** Stored as hashes only ([section 7.1](#71-three-role-bound-credentials)). `DEBUGGEN_TOKEN`, `DEBUGGEN_INGEST_URL` and `DEBUGGEN_PROJECT_ROOT` are injected into launched processes and are deliberately absent from `.env.example`; a token set by hand is never valid. `scripts/dev-instrumented.mjs` (`pnpm demo:instrumented`) never prints, logs or writes the editor credential it reads, and never handles a server-agent credential itself.
- **The repository gate.** `pnpm check:secrets` (`scripts/check-secrets.mjs`) runs inside `pnpm verify` and in CI. It reads every file `git ls-files` lists and fails on a tracked environment file other than the two examples, provider-key prefixes, JWT-shaped strings, private-key headers, values of 32 or more characters above 4.0 bits per character bound to key-like names, and connection strings with embedded credentials. Its only exemptions are the two development placeholders in `scripts/check-secrets.allowlist.json`, each matched by exact value and permitted path. It never reads the git directory and fails closed when it cannot inspect the repository.
- **CI.** The workflow clones fresh and never archives or caches the git directory.
- **Logs.** The service logs locally through pino to its own standard output, at `DEBUGGEN_LOG_LEVEL`. Records carry counts, identifiers, rule ids and redacted attributes — never raw event payloads, credentials, request-key secrets or file contents — and pass through the two redaction layers of `apps/local-service/src/logging.ts`.

## 11. Reporting a vulnerability

Please report a suspected vulnerability privately, and do not open a public issue, discussion or pull request for it first.

1. **Report privately** through a GitHub private security advisory on this repository (its Security tab; the repository is the one named in the root `package.json` `repository` field). If advisories are unavailable to you, contact the maintainer listed in the repository and ask for a private channel.
2. **Include** the affected commit or version; the component (VS Code extension, Chrome extension, local service, telemetry agent or preload, instrumentation, model provider, demo application); reproduction steps; the impact you observed or expect; and any logs, with credentials and personal data removed.
3. **Expect** an acknowledgement, normally within five working days, then an assessment and a fix or mitigation plan. Please allow time for a fix before disclosing publicly; you will be credited unless you ask not to be.

**Supported versions.** Debug Generator is a local developer tool distributed from source; fixes land on the default branch, and there are no maintained release branches.
