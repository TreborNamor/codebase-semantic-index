# Implementation and validation record

CodeConverge is a standalone Windows application installed at user level. Its
TypeScript companion supplies trusted VS Code workspace authority; Python owns
indexing, embeddings, storage, retrieval and the MCP interface. The implementation
uses supported editor APIs and does not depend on its source checkout at runtime.

## Delivered components

| Area | Implementation |
| --- | --- |
| Workspace authority | Per-window control/MCP capabilities, generation checks, canonical local roots, trust enforcement |
| Discovery | Bounded text reads, final-handle authorization, exclusions and nested Git ignore rules without Git discovery |
| Parsing | Offline Tree-sitter grammars, structural/token-budget fallbacks, exact original source locations |
| Inference | Official Qwen3-Embedding-0.6B Q8_0, public llama.cpp API, CPU, last pooling, normalized 1024-dimensional vectors |
| Storage | Independent persistent SQLite WAL/FTS5/sqlite-vec indexes and a shared content-addressed embedding cache |
| Retrieval | Semantic, BM25 and exact/prefix symbols, reciprocal rank fusion, filters, duplicate suppression and live source checks |
| Lifecycle | Automatic activation/reconciliation, debounced saves, stable watcher ownership, one fair worker, idle unload/exit |
| MCP | search_code, find_symbol, index_status, refresh_index, manage_index |
| Maintenance | Editor-bound confirmation for rebuild/deletion, configurable cache policies, corruption quarantine/recovery |
| Installation | Hashed Windows dependency locks, normal wheel, VSIX, global guidance, offline transfer, upgrades and removal |

## Executed validation

- 45 Python tests passed, including actual offline CPU inference, Windows named
  pipes and stdio MCP, isolation, updates, metadata changes, corruption recovery,
  persistence, confirmation boundaries and idle exit.
- Two Node transport tests and TypeScript compilation passed.
- Fresh offline installation and repeat installation passed in a separate runtime;
  isolated imports worked outside the checkout with a deliberate cwd shadow module.
- Disposable VS Code hosts verified startup discovery and empty/untrusted rejection.
  Their untrusted fixture results are not claimed as trusted retrieval passes.
- Actual trusted editor sessions verified A/B/A switching, cached index reuse,
  editor-saved changes, simultaneous windows, multi-root removal/restoration,
  complete restarts, and Copilot Auto parent/custom-subagent MCP calls.
- Forty-eight pre-labeled navigation queries compared lexical, semantic and hybrid
  retrieval with the real local model and blocked network access.

See [the demonstration](DEMONSTRATION.md), [integration compatibility](INTEGRATION-GATE.md),
[benchmark methodology/results](BENCHMARKS.md), and the public summary in
`artifacts/integration/release-audit.json`. Machine-specific execution logs and
private diagnostic files remain local and are excluded from version control and
new source/distribution bundles.

## Measured limitation

The authored benchmark meets the initial relevance and warm-query targets. The
entirely changed 979-token background update measured 10.63 seconds p95 on the
working laptop, excluding the extension notification delay. The five-second
1,000-token update target is unmet. No large-repository performance claim is made.
Haiku 5.5 was unavailable locally; the user authorized Copilot Auto for validation.

The selected architecture remains the original companion + shared Python engine.
An experimental read adapter was removed after direct MCP subagent calls were
verified. No project configuration or instruction injection is required.
