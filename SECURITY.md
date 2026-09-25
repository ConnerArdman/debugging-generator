# Security Policy

Debug Generator runs entirely on the developer's machine and has no hosted component. To answer a debugging question it writes temporary, fully reversible instrumentation into the developer's own project, reads that project's source and runtime telemetry (browser interactions, React renders, requests, server spans and database queries), and — only when the `anthropic` model provider is configured with `ANTHROPIC_API_KEY` and `DEBUGGEN_MODEL` — sends redacted, bounded code excerpts and telemetry aggregates off the machine. With `DEBUGGEN_PROVIDER=deterministic`, nothing leaves the machine. The service defaults to `deterministic`, but the VS Code extension's `debuggen.provider` setting defaults to `anthropic` and is forwarded when the extension starts the service; see [what may leave the machine, and when](docs/SECURITY.md#4-what-may-leave-the-machine-and-when).

## Reporting a vulnerability

Report a suspected vulnerability privately through a GitHub private security advisory on this repository (**Security → Report a vulnerability**), not in a public issue, discussion or pull request. Name the affected commit, the component and the reproduction steps, but do not attach captured telemetry, session databases, tokens, API keys or customer data; describe them instead. We aim to acknowledge reports promptly. What to include, and what to do if private reporting is unavailable to you, is in [section 11 of `docs/SECURITY.md`](docs/SECURITY.md#11-reporting-a-vulnerability).

## Supported versions

| Version                                           | Supported                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Development line (`master` and `blitzy` branches) | Yes — security fixes land here                                                                               |
| Released versions                                 | None yet: the monorepo is at `0.1.0` and is not published to the Chrome Web Store or the VS Code Marketplace |

## Where the details live

[`docs/SECURITY.md`](docs/SECURITY.md) is the authoritative security and privacy model. It covers what is captured and what never is, what can leave the machine and when, the redaction rules and the files that implement them, model-provider behaviour and deterministic mode, the risks of generated instrumentation and its reversibility guarantees, the local service access boundary, session data at rest, extension permissions and secrets handling.

## Secrets

No secrets are committed: the two `.env.example` files hold placeholders and the throwaway local demo-database credential only, `ANTHROPIC_API_KEY` is read from the service's environment, and `pnpm check:secrets` scans every tracked file in `pnpm verify` and in CI.
