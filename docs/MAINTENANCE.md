# Maintenance and troubleshooting

## Locate the installation

`~/.codeconverge/installation.json` records the actual `home` and `python` paths.
The pointer handles packaged-app AppData virtualization; use its values instead
of assuming the logical AppData path is visible identically in every process.
`python -I -m codeconverge engine-info` prints nonsecret home/pipe/version details.
The installed console command is in `<home>/runtime/Scripts/codeconverge.exe`.
No shell PATH change is necessary for the extension.

Open **CodeConverge: Show Status** for current root IDs, counters, progress, errors
and model status. Logs live under `<home>/logs`; source/query text and capability
tokens are intentionally omitted. Audit files rotate at approximately 2 MB.
Do not publish raw Copilot event files: they can contain conversation data and
opaque model payloads. The checked-in integration artifacts are bounded exports.

## Startup and tools

* Select the **Copilot** harness in the editor. The Local, Claude, Codex and CLI
  harnesses are different clients; no claim is made that a user-level CLI MCP
  config inherits this window's authority.
* Open a trusted local file folder. Empty/untrusted/remote windows do not grant
  source access. CodeConverge never changes workspace trust itself.
* If a newly installed extension is absent, reload the editor window. If the
  runtime pointer was moved, rerun the installer or set the optional user-level
  `codeconverge.runtimePath`; never set a workspace root manually.
* If status shows indexing/error, inspect warnings. Lexical/symbol retrieval can
  still be useful while Qwen is unavailable. Missing/corrupt assets require the
  explicit `setup` command; runtime never silently downloads them.
* Fixed-tool custom agents must list the CodeConverge tools. The bundled read-only
  agent uses qualified names accepted by the tested host. Agent instructions
  encourage tool use but cannot guarantee any model's decisions.

Copilot 0.72 at its default tool-deferral threshold of 1 exposed tool names to
children without callable schemas. Direct MCP child calls succeeded at 30, before
and after a complete editor restart. The extension sets that user value only
when no explicit global value exists. **Restore Original Copilot Tool Loading**
restores the default and opts out. A user's subsequent explicit value is respected.
This compatibility adjustment is not a trust, approval or authentication change.
Haiku 5.5 must be verified on the user's other machine; Auto was tested here.

## Saved changes and freshness

Only saved disk content is indexed. The extension batches notifications for
500 ms and Python debounces for another 500 ms by default. Status remains
Indexing while work is queued/running. Completed lexical chunks and vectors are
available throughout; a missing result in a partial index does not prove absence.
Source-hash verification suppresses stale candidate snippets during the gap.
Large edits require more CPU time than a typical function save.

Periodic discovery runs every 5 minutes while a root is active; full hashing
runs every 30 minutes and whenever a project reopens. Watcher exclusions or a
brief window handoff can miss notifications, so use **Refresh Workspace** when
investigating a suspected missed change. Indexes are retained when folders close.

## Rebuild, delete and cleanup

Refresh is incremental. Rebuild requires the originating window's explicit modal
approval, cancels the previous slice, recreates derived rows and reuses matching
shared embeddings. It does not delete source. A request nonce expires after
120 seconds and is invalid after a workspace generation change or first decision.

**Manage Cached Projects** lists project paths, IDs, active state and bytes. Only
inactive indexes may be deleted. MCP requests prepare the same editor dialog;
the MCP capability cannot send the control-channel decision. For unused caches,
`manage_index(action="cleanup")` proposes the exact inactive IDs for confirmation.

`cache_limit_mb` applies to project indexes. The default manual policy reports an
over-budget warning and leaves deletion to you. Setting `cleanup_policy="lru"`
explicitly opts into automatic age/size eviction of inactive derived indexes.
Active projects are preserved even when they exceed the budget. The fixed model
and parser assets and independently bounded embedding memoization are shared.

## Settings, upgrade and corruption recovery

Settings load at engine startup. To apply changes, close VS Code windows using
CodeConverge, run the installed runtime with `-I -m codeconverge stop-engine`,
then reopen the editor. An incompatible live engine refuses an upgrade connection
instead of serving another version's protocol. Normal file/folder changes never
require stopping the engine.

Reinstall from the packaged release. The source checkout is not needed at runtime.
The installer verifies all locked wheel hashes and asset checksums and preserves
modified guidance files. A prior managed guidance hash allows safe managed updates.
`scripts/test-install.ps1` tests a fresh offline runtime and repeat installation
without changing the registered user pointer.

SQLite integrity checks and runtime corruption detection preserve damaged files
under the affected cache's `quarantine/`, recreate the derived index and rescan
authorized source. Shared-cache corruption likewise refills locally. A disk-full
or permission failure remains an explicit error; free space/fix access and refresh.
Quarantine is retained for inspection and counts toward stored index size.

## Uninstall

First use **Restore Original Copilot Tool Loading** if you want the editor default
back, then close CodeConverge windows. `scripts/uninstall.ps1 -WhatIf` previews
removal. Running it normally asks PowerShell confirmation, removes the extension,
registered pointer, runtime and unchanged managed guidance, and retains models
and project indexes. `-RemoveCachedData` additionally requests removal of those
derived caches. Modified user guidance is preserved. No project files are touched.
The uninstall command is provided but has not been used to remove this working
installation during validation.
