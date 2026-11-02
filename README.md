# CodeConverge

Local hybrid code search that automatically follows trusted folders opened in
Windows VS Code. Install once, use **File → Open Folder**, and let Copilot search
the current workspace through MCP. Single-root, multi-root and concurrent editor
windows have independent authority and persistent project indexes.

The companion obtains roots from `workspace.workspaceFolders`; it never guesses
from the working directory, Git, or the focused editor. No project registration,
project-local MCP file, or injected project instruction file is needed. An empty
or untrusted window grants no source access. Closing a folder preserves its cache.

## Install once

Requirements: Windows x64, standard 64-bit CPython 3.13, VS Code 1.144 or later,
and GitHub Copilot with the **Copilot** harness. Node/npm are needed to build the
extension from source, but not to use the packaged VSIX. The tested CPU is an
Intel i7-11370H with 16 GiB RAM; allow approximately 2 GiB for the indexing process.

From this source checkout:

```powershell
git clone https://github.com/TreborNamor/codebase-semantic-index.git
cd codebase-semantic-index
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\scripts\build.ps1
.\scripts\install.ps1
```

The installer uses hashed, pinned runtime wheels, creates a dedicated normal
installation outside the checkout, verifies the official Qwen model, caches
21 Tree-sitter grammars, installs the VSIX and adds two managed user-level files:

```text
~/.copilot/instructions/codeconverge.instructions.md
~/.copilot/agents/codeconverge-research.agent.md
```

`COPILOT_HOME` is respected. Existing customized files are preserved. The dynamic
MCP provider supplies each window's capabilities; a static user MCP configuration
cannot safely provide this editor authority and is unnecessary.

Initial setup requires Internet access for packages and verified assets.
Afterward, discovery, parsing, inference, storage and retrieval run locally with
no inference service, TCP listener, Docker or database server. Copilot itself
receives the bounded excerpts requested by its tools as part of normal agent use.

Already-open windows need **Developer: Reload Window** after an upgrade. Normal
folder changes require no reload, path setting or manual refresh.

## Use it

Open a trusted local folder. The status bar moves from **Indexing** to **Ready**.
Lexical and symbol results become searchable before embeddings finish; tool
responses explicitly identify partial indexes. Saved on-disk changes synchronize
automatically. Unsaved editor buffers are not indexed.

Examples for Copilot:

* “Use CodeConverge to find where dashboard filter selections refresh metrics.”
* “Find the definition of `fetchDashboardMetrics`.”
* “Search this workspace for how payment retries avoid duplicate processing.”
* “Delegate this investigation to the codeconverge-research subagent.”

The agent must choose to call a tool; registration alone does not guarantee model
behavior. The installed instructions encourage focused searches, top-k 5, result
reuse, source verification before edits and native-tool fallback when unavailable.
Custom subagents with fixed tool allowlists must include CodeConverge explicitly.

| Tool | Behavior |
| --- | --- |
| `search_code` | auto/hybrid/semantic/lexical/symbol retrieval; relative path globs, language filters, top_k 1–50 |
| `find_symbol` | Exact/prefix definitions, classes, components, routes and exported identifiers |
| `index_status` | This window's roots, project IDs, counts, progress, synchronization, model and warnings |
| `refresh_index` | Incremental resynchronization; full rebuild requires an editor confirmation |
| `manage_index` | List cached metadata; propose inactive cache deletion/cleanup with editor confirmation |

Results contain relative paths, source URIs, symbols, exact excerpt lines, channel
ranks and index freshness. Before returning an excerpt the engine verifies its
file hash against current saved source. Changed/deleted files are suppressed and
scheduled for synchronization. Search never silently expands to cached projects.

Maintenance commands: **CodeConverge: Show Status**, **Refresh Workspace**,
**Rebuild Workspace**, **Manage Cached Projects**. Rebuild reuses valid cached
embeddings. Deletion requires closing all windows using that index, selecting the
exact cache and approving the originating editor's dialog. An MCP caller cannot
approve maintenance by supplying a boolean argument.

## Architecture and storage

A small TypeScript companion owns trusted workspace detection, watchers, status
and `lm.registerMcpServerDefinitionProvider`. Python owns everything else. Stdio
MCP proxies use window-scoped capabilities to reach one current-user-only Windows
named pipe. A shared model and one fair background indexing worker serve all
windows; interactive inference takes priority between small indexing batches.
One window is elected to watch each project, preventing duplicate watcher sets.

```text
%LOCALAPPDATA%/CodeConverge/
  runtime/             installed Python package and pinned dependencies
  config/              host identity, optional settings.toml
  models/              one verified Qwen Q8_0 and tokenizer
  parsers/             verified offline grammar manifest and DLLs
  indexes/<project-id>/ SQLite WAL + FTS5 + sqlite-vec, source metadata
  cache/               shared content-addressed embeddings
  logs/                bounded diagnostics, no queries or source text
```

A user-profile `~/.codeconverge/installation.json` pointer records the canonical
installation path. This handles AppData virtualization under packaged Windows
apps and keeps ordinary VS Code launches and CLI setup on the same store. The
installed wheel has no import dependency on this development checkout.

Project identity includes canonical path, persisted host identity and directory
identity. Same-named folders do not collide. Reopening verifies content hashes;
unchanged chunks and embeddings survive file moves, sessions and restarts.
SQLite commits file replacements and vector updates transactionally. Damaged
derived databases are quarantined and rebuilt locally; source files are untouched.

The backend uses official **Qwen/Qwen3-Embedding-0.6B Q8_0 GGUF**, llama.cpp on CPU,
last-token pooling, EOS handling, L2 normalization and 1024 dimensions by default.
Queries receive the Qwen task instruction; documents do not. Output dimensions,
threads, batch/token budgets and idle behavior are configurable. A persistent
embedding cache includes the model/configuration identity and content in its keys.
SQLite BM25, exact/prefix symbol ranking and cosine neighbors are fused with RRF.
No separate neural reranker is required. See [architecture](docs/ARCHITECTURE.md).

## Configuration and exclusions

Settings are optional and global: `<application-home>/config/settings.toml`.
See [the complete example](docs/settings.example.toml). Restart the engine after
changing settings (close its Code windows, run `codeconverge stop-engine`, reopen).
New embedding settings invalidate vectors; parsing settings rechunk saved source.
Normal workspace switching and file synchronization never require these commands.

Default filtering excludes Git history, environment files, dependencies, generated
builds, binary assets, model/index storage and lockfiles. Nested `.gitignore`
rules are respected without running Git, including useful untracked files.
Tests, SQL, schemas, application configuration and documentation remain eligible.
Symlinks/junctions are not traversed; source reads validate the final opened handle.
Global/project-path filter overrides can extend or negate default generated-file
rules; `.git`, `.env*`, binaries, escaped roots and application storage stay blocked.
Unknown languages use explicit structural/token-budget fallbacks. Additional
supported grammars can be cached with `codeconverge setup --languages kotlin`.

Defaults: 4 CPU threads, 384-token chunks, 512 tokens per inference batch,
4 sequences, 500 ms debounce, 5-minute reconciliation, 30-minute full hash checks,
5-minute model idle unload and 2-minute engine exit after the final editor closes.
The 2048 MiB memory budget is a monitored process budget, not an OS hard limit.
Embedding memoization has a 512 MiB logical budget. Project indexes have a 10 GiB
budget with manual cleanup by default; explicit `cleanup_policy = "lru"` enables
age/size cleanup of inactive caches. Active indexes are never evicted.

## Validation and measured performance

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
Push-Location extension
npm ci --ignore-scripts
npm run compile
npm test
Pop-Location
.\.venv\Scripts\python.exe scripts\benchmark.py
.\scripts\test-vscode.ps1
```

The benchmark freezes labels before inference, indexes only `benchmarks/corpus`,
blocks network calls and compares all three retrieval modes on 48 labeled
queries (16 tuning, 32 held out). The fixture is authored and has one labeler;
results do not establish relevance on arbitrary large repositories. Results and
methodology are in [benchmarks](docs/BENCHMARKS.md) and
[raw measurements](artifacts/benchmarks/retrieval.json).

| Mode | Recall@5 | Recall@10 | MRR@10 |
| --- | ---: | ---: | ---: |
| Lexical | 0.979 | 0.979 | 0.944 |
| Semantic | 1.000 | 1.000 | 0.979 |
| Hybrid | 0.979 | 0.979 | 0.938 |

Measured first indexing: 16 files, 95 chunks, 3,665 inferred tokens in 27.75 s.
Warm uncached semantic p95: 302 ms initially and 371 ms on verification. Cold semantic query: 1.22–1.43 s. Peak process RSS:
1,243 MiB. Reopen synchronization: 79 ms, zero inferred embeddings. The initial
23-token single-file update p95 was 286 ms, excluding watcher debounce. The wholly
changed 979-token background update measured a 10.63 s p95, including Python
debounce and excluding the extension's additional 500 ms. The 5-second target
for 1,000-token replacements is unmet on this laptop. Hybrid timing reused query
vectors from semantic mode. See the scaling data in the benchmark report.
Semantic ranked better than hybrid on this fixture; no improvement is claimed.

Actual Copilot Auto parent and compatible custom-subagent MCP calls, multi-root
removal/restoration, independent windows and a full editor restart have evidence
in [the complete demonstration](docs/DEMONSTRATION.md) and
[the integration record](docs/INTEGRATION-GATE.md). Haiku 5.5 is unavailable on
this computer; Auto was explicitly authorized for validation. The initial child
schema-loading failure was traced to Copilot's tool-deferral threshold. The
companion sets 30 once when no explicit user value exists, preserves user choices,
and offers **Restore Original Copilot Tool Loading** to undo and opt out. No
trust, authentication, privacy or tool approval setting is changed.

## Offline transfer, upgrades and removal

`scripts/bundle.ps1` creates a checksummed Windows bundle containing the wheel,
VSIX, locked dependency wheels and verified model/parser assets. Standard x64
CPython 3.13 and VS Code must already exist on the destination. Run there:

```powershell
.\scripts\install.ps1 -Offline -Wheelhouse .\wheelhouse -AssetsDirectory .\assets
```

Online upgrades use the same installer. Close editor windows before replacing a
loaded inference runtime, then reopen; cached indexes survive. The installer
preserves customized managed guidance files. See [maintenance and troubleshooting](docs/MAINTENANCE.md)
for recovery, safe removal, compatibility details and uninstall instructions.

This release supports local Windows volumes. Remote SSH, containers, WSL,
network shares, macOS and Linux integration are outside the tested scope. Dense
search uses persistent exact cosine scans suitable for the target local workloads;
ANN and very large-repository performance are not claimed. Saved disk content is
indexed, and source excerpts remain untrusted data.

MIT-licensed application; model and dependencies retain their respective licenses.
