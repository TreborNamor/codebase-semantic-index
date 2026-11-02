# Live Copilot integration gate

CodeConverge installs outside this checkout. Its companion grants authority
from workspace.workspaceFolders and workspace trust, then registers a Python
stdio MCP definition per window. MCP inputs cannot select roots.

## Verified evidence

Actual VS Code 1.144 / Copilot 0.72 sessions verified automatic provider discovery,
trusted folder authority, parent tool calls, custom-subagent calls identified by
nonempty child agent IDs, multiple windows, multi-root removal/restoration and
complete editor restarts. Copilot Auto resolved to GPT-6 Luna. Haiku 5.5 was not
available on this machine, and Auto was explicitly authorized for validation.

The disposable extension-development hosts separately verify empty/untrusted
rejection and stdio invocation. They do not establish trusted Copilot retrieval.
The real trusted workflow and source-line checks are described in
[the demonstration](DEMONSTRATION.md). Raw machine-specific execution records
remain local; the committed summary is `artifacts/integration/release-audit.json`.

## Subagent root cause and verified fix

The editor default tool-deferral threshold of 1 prevented small subagent tool
sets from receiving callable schemas. Two bounded threshold-30 experiments
succeeded: first through a read adapter, then through direct MCP tools. Both
have child agentId-bearing execution events, successful results and original
source-line checks. Temporary settings were restored after each experiment.
The adapter was removed; the final integration uses direct Python MCP.

The companion sets the user-level threshold to 30 once if no explicit global
value exists. Large tool catalogs still use deferred loading. An explicit
user choice is preserved. The Command Palette includes a restoration command
that also opts out of automatic setup. No trust, approval or authentication
setting changes. The earlier question about continuing with unverified child
access no longer applies: actual direct child calls now pass.

A complete editor shutdown/relaunch was followed by successful actual parent
and child MCP calls (copilot-after-full-restart.json). Returned source URIs fix
multi-root links that a model might otherwise incorrectly construct from the
first workspace folder. The live ordinary-window root-removal check passed:
Beta disappeared, Alpha remained, and index_status listed exactly one root.
The original fixture workspace file was restored; restoration verified both roots and the same project IDs
(copilot-root-restoration.json). Development-mode tests continue reporting untrusted and are not
claimed as trusted-source passes.

## Gate outcome

The integration gate is complete. Actual parent and compatible custom-subagent
calls, trusted multi-root scope changes, full restart, separate windows, and
empty/untrusted rejection have evidence. The extension-development host's
untrusted fixture result remains a distinct test result.

This gate records the earlier integration prototype. The completed pipeline now
has real Qwen retrieval, persistent reuse and saved-file evidence in
`artifacts/integration/live-*.json`, and measured retrieval/update benchmarks in
`artifacts/benchmarks`. See the application README for current release behavior.

## Reproduce

1. Open a trusted folder; select the Copilot harness and Auto.
2. Request CodeConverge index_status and a known definition.
3. Delegate once to codeconverge-research, requiring a child status and symbol
   call and an honest report if either tool is unavailable.
4. Compare event agentId, execution success, source lines, and engine audit.
5. Repeat in another folder, multi-root workspace, and after restarting.

No per-project MCP configuration or fixed development root is installed.
Custom agents with fixed tool lists must explicitly permit relevant tools.
