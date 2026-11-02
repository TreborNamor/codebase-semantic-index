# Actual VS Code / Copilot demonstration

This records the installed Windows application, not a mocked MCP harness.
Copilot's selected mode was Auto, resolving to `gpt-6-luna`. The user authorized
Auto because Haiku 5.5 is available only on their other computer.

Machine-specific execution records mentioned below remain local and are not
committed. The public summary is `artifacts/integration/release-audit.json`;
benchmark measurements are committed under `artifacts/benchmarks`. The export
script can regenerate selected tool records for a local validation session.

The runtime is a normal wheel under the canonical user application store,
outside the source checkout. Before the first folder was selected, that store's
`indexes/` was empty and the ordinary editor showed **No workspace**. The
extension-development tests independently verified empty/untrusted rejection.

## A → B → A

1. In the ordinary empty editor, select **Open Folder** and choose
   `integration/fixtures/project-a`. The folder picker is the editor's standard
   Open Folder command, not an index configuration dialog. Status showed
   **Indexing, 1 file, 3 chunks**, then **Ready** before any refresh tool call.
2. Ask Copilot to invoke `index_status` and hybrid search for selected dashboard
   regions. Actual MCP returned project `d8418f1a1aa1d49f6ad537b3d94c2a9c`, all
   three vectors committed, Qwen Q8_0 on CPU, and `update_dashboard_filters` in
   `dashboard.py`, lines 9–13, ranked first by both semantic and lexical channels.
   Evidence: `artifacts/integration/live-project-a.json`.
3. Use **File → Open Folder** to select `project-b`. Copilot returned only
   project `ffa6a5d2b6dad25d6e5b31e02c4cd9c5`. `alpha_beacon` was absent;
   hybrid invoice search found `calculate_invoice_total` in `billing.py`,
   lines 9–11. A's index remained on disk. Evidence: `live-project-b.json`.
4. Reopen A from the editor's recent folders. Its project ID and three vectors
   were reused. Copilot's status reported the latest synchronization as zero
   changed files, one unchanged file and **zero inferred texts**. Its cumulative
   project inference count remained three. `alpha_beacon` was still at lines 4–6.
   Evidence: `live-project-a-return.json`.

The folders contain no `.git` directory. The editor offered to open a repository
found in their parent; that unrelated notification was dismissed. CodeConverge
kept the actual selected subfolder as its authority and did not use the parent
repository as a root. No project MCP or instruction file was added.

## Saved edit and actual custom subagent

5. Open `dashboard.py` in the actual source editor. Append
   `selected_dashboard_region`, with a saved-region lookup and an `all` default,
   then press **Ctrl+S**. No refresh/rebuild command was used. The watcher updated
   the index to four chunks. Its source hash matched saved bytes and its new
   vector was committed. Evidence: `live-saved-edit.json`.
6. Delegate to the installed `codeconverge-research` agent. The **child** made
   direct `index_status`, `find_symbol`, and semantic `search_code` calls. Native
   Copilot events carry child ID `2ac27b3e-6ac7-49a9-bcaa-de01873315cd`; all three
   succeeded. The new function was the semantic top result at lines 15–17. Its
   exact returned excerpt was compared with disk source. Evidence:
   `live-saved-edit-subagent.json`. Parent fallback calls are not counted as child
   success.
7. Restore the original owned fixture byte-for-byte. The same watcher removed
   the temporary definition automatically and returned the index to three chunks.
   The fixture in the delivered source is the original, not the temporary edit.

## Concurrent windows and complete restart

8. Keep A open and open B in a separate ordinary editor window. The shared engine
   reported two editor sessions and one boot ID. Copilot in B received its own
   session `6f3a402ddf3c9bd1e67e59473af2bd9d`, found `beta_beacon`, and could not
   find A's `alpha_beacon`. Evidence: `live-concurrent-windows.json`.
9. Close both windows and stop the now-editorless shared engine. Reopen A with the
   installed application. The engine boot ID changed from `2f304e640b6ade4b` to
   `be02cebb3c059a0f`. Copilot found the same A project ID, three committed vectors,
   zero document inference, and an unloaded model before its new semantic query.
   The query returned `update_dashboard_filters` correctly. A representation
   metadata update reused three content-cached embeddings without inference.
   Evidence: `live-full-restart.json`.

Separate earlier gate evidence covers actual trusted multi-root removal and
restoration, parent/custom-child calls after a full restart, and independent
windows. The disposable extension-development host reports untrusted for its
folder fixture; that is recorded as rejection, not a trusted-source pass.

All `live-*.json` exports include only selected tool envelopes/results and child
execution metadata. They omit credentials, capability tokens, opaque model
payloads and reasoning data. Source snippets are bounded, owned fixtures used
under the user's explicit integration-testing authorization.

## Acceptance audit

| Requirement | Implementation and evidence |
| --- | --- |
| Install once, independent of checkout | Normal wheel/VSIX, canonical user pointer; fresh and idempotent offline installation test; isolated imports outside checkout with a shadow module in cwd |
| Automatically follow trusted folders | Supported workspace APIs; actual normal folder picker A/B; startup activation and empty/untrusted extension-host tests |
| No project setup | Dynamic window-capability MCP provider; native user instructions/agent; no project config injection |
| Persistent isolated project caches | Per-canonical-root SQLite; stable IDs; A/B/A and complete restart evidence |
| Reuse unchanged embeddings | Hash reconciliation, row reuse and global content cache; actual zero-inference return/restart, rename tests |
| Automatic saved updates | Actual editor Ctrl+S → watcher → committed fourth chunk → actual child retrieval; automatic removal after fixture restoration |
| Local CPU Qwen | Official pinned Q8_0 SHA, last pooling/EOS/normalization tests, blocked-network benchmarks and model tests |
| Hybrid retrieval | BM25, exact/prefix symbols, cosine vectors, RRF; 48 pre-labeled navigation queries and real parent/child tool results |
| Copilot and supported subagents | Actual Auto parent calls and agentId-bearing custom-child calls; original schema issue and reversible compatibility fix documented |
| Prevent cross-project source | Session/control capabilities and generations, final source hashes, authorized handles; actual B exclusion while A open, traversal and lifecycle tests |
| Exclude history/dependencies/generated data | Discovery policy and nested ignore tests; actual folder authority stayed below the parent Git repository |
| Bound CPU/context overhead | One lazy model, stable watcher ownership, one fair worker, native-batch query priority, compact excerpts and measured budgets |

The functional acceptance criteria pass in the tested Windows environment.
Performance is measured separately: the small-corpus relevance and warm-query
targets pass; the 1,000-token entirely changed file update target is **unmet**.
See `BENCHMARKS.md` for data, cache-hit distinctions and test-size limitations.
