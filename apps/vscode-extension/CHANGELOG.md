# Change Log

All notable changes to the **Debug Generator** extension are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the extension follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-20

First release of the editor side of Debug Generator. You ask a debugging question about the project
open in your workspace here; the generated debugging panel appears in the **Debug Generator** panel
in Chrome DevTools, and the runtime items it shows link back to the lines of source they came from,
which open in this editor.

### Added

- **Debug Generator** activity-bar container holding two views: **Session** (the webview you work
  in) and **Sessions** (the history of past sessions).
- Question entry in the Session view: a plain-English question about the project in the workspace
  folder, asked against the element you selected in the DevTools panel when one is selected.
- Live pipeline progress, rendered from the events the local coordination service actually emits as
  it understands the question, investigates the code, plans instrumentation and reaches
  "Ready to capture" — with the failing stage shown as failed rather than dressed up as an answer.
- Relevant-files list: the files and symbols the code investigation selected, each with the reason
  it was selected; selecting a row opens it in the editor.
- Modifications list: every file the session instrumented, with its status (applied, reverted or
  conflict) and a diff view of the exact change that was written to it.
- Capture controls in the view and on the view title bar: arm a capture, reproduce the problem in
  the browser while the view says so, then stop it and let the analysis run.
- Analysis summary that keeps the observed facts apart from the likely causes inferred from them,
  mirroring what the generated panel shows.
- Follow-up questions: answered from the evidence already captured when that is enough, or by
  adding to the existing instrumentation plan and asking you to reproduce the problem once more when
  the follow-up needs a signal the previous capture did not collect.
- End-of-session control that reports the cleanup outcome (clean, partial or conflict) for the files
  the session touched.
- Sessions view listing stored sessions by project and date; reopening one restores its analysis and
  its generated panel in both surfaces without re-running the capture.
- Status line showing whether the coordination service is reachable and which model provider it is
  configured with, plus the pairing code display used to connect the DevTools panel.
- Session commands, all under the `Debug Generator` category: `Start Debugging Session`,
  `End Session`, `Show File Modifications`, `Reopen Session` and `Open Source Location` — the last
  two are invoked from the views and from the generated panel rather than from the Command Palette.
- Capture commands: `Start Capture` and `Stop Capture`.
- Service commands: `Start Local Service`, which starts the coordination service bundled with this
  extension, and `Launch Dev Server`, which has the service start your project's development server
  with the telemetry preload attached (or adopt one that is already running).
- Pairing and credential commands: `Pair Chrome DevTools Panel`, which shows a short single-use code
  to enter in the DevTools panel, and `Rotate Service Token`, which invalidates every issued
  credential and open connection, so a paired browser has to pair again and an instrumented
  development server has to be relaunched.
- Stored-data command: `Purge Stored Sessions`, which deletes stored sessions, their captured
  telemetry, panels and file backups.
- Setting `debuggen.serviceUrl` — base URL of the local coordination service, which defaults to
  `http://127.0.0.1:43117`.
- Setting `debuggen.autoStartService` — start the bundled service automatically when a health check
  against that URL fails; turn it off to run the service yourself.
- Setting `debuggen.devServerUrl` — the development server URL of the project you are debugging;
  leave it empty to let the service detect a running server for the workspace folder or launch one.
- Setting `debuggen.provider` — the model provider the service reasons with: the hosted `anthropic`
  provider, or `deterministic`, which is rules-based, runs offline and sends nothing off the
  machine.
- Click-to-source: a source location opens the file at its line and column, places the selection
  there, reveals it in the editor and highlights the line briefly so you can see where you landed.
- URI handler `vscode://debuggen.debug-generator/open?file&line&col`, used when the editor is not
  connected to the service as a client. It validates the parameters independently, rejects paths
  that resolve outside an open workspace folder, and asks for confirmation before opening anything.
- Self-contained packaging: the VSIX embeds the local coordination service, its versioned prompt
  files and the telemetry Node preload, so installing the extension is the only install step on the
  editor side.
- Reversible-instrumentation guarantees on the editor surface: every change the session makes to
  your files is listed with its diff and status, ending the session (or deactivating the extension
  with a session still open) triggers cleanup that restores each file from the copy recorded before
  it was written, and a file you edited while it was instrumented is reported as a conflict and left
  exactly as you left it.
- Theme support: the view follows the editor theme, mapping light, dark and high-contrast themes
  onto the shared design tokens the generated panel also uses.
