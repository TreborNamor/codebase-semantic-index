# Measured benchmarks

Raw data: `artifacts/benchmarks/retrieval.json` (initial run),
`retrieval-final.json` (verification after scheduler changes), `updates.json`,
`model-smoke.json`, `cpu-options.json`, `batch-options.json`.

## Method

The dataset contains 48 authored navigation queries and preassigned path/symbol
labels. `benchmarks/queries.json` is outside the indexed `benchmarks/corpus`.
Before inference the runner hashes both labels and all corpus files, checks that
every labeled definition exists structurally, then indexes a temporary copy.
The frozen digest is
`68c33ec9a3c605a9d4c132e38114f074e69c3cf741c48af76dadfda33b782530`.
Every third query is a tuning item (16); the other 32 are held out. RRF weights
were not fitted on these results. Later engineering changes affected scheduling
and bounded batches, not labels or relevance weights.

Recall is a hit on the exact labeled path and, where supplied, qualified symbol.
Each query has one labeled target. MRR is truncated at the returned top 10. A
useful containing chunk may therefore fail a stricter symbol label. This is one
labeler's authored fixture, not independent human adjudication, a public code
retrieval dataset, or evidence of relevance across all repositories.

Measurements use the actual official Q8_0 model on an i7-11370H laptop, four CPU
threads, 16 GiB RAM, 1024 dimensions, 384-token chunks and 512-token native
batches. Python socket creation is blocked during inference, indexing and queries.
The setup/download interval is measured separately. Lifecycle unit tests use
clearly identified deterministic doubles; their results are not quality scores.

## Initial retrieval results

| Split / mode | Queries | Recall@5 | Recall@10 | MRR@10 |
| --- | ---: | ---: | ---: | ---: |
| All / lexical | 48 | .9792 | .9792 | .9444 |
| All / semantic | 48 | 1.0000 | 1.0000 | .9792 |
| All / hybrid | 48 | .9792 | .9792 | .9375 |
| Held out / lexical | 32 | .9688 | .9688 | .9531 |
| Held out / semantic | 32 | 1.0000 | 1.0000 | .9688 |
| Held out / hybrid | 32 | .9688 | .9688 | .9219 |

The initial hybrid result meets the engineering targets of .85/.95/.75. Semantic
ranked better on this small fixture; hybrid superiority is not claimed. No neural
reranker was added to optimize this dataset. Final verification is retained as a
separate raw run so timing variation is visible instead of replacing measurements.

Cold semantic query (model unloaded): 1.22 seconds. Warm uncached semantic p95:
302 ms. Per query the runner executes lexical, semantic, then hybrid; hybrid
therefore reuses the query vector computed by semantic, and its 43 ms p95 is a
cached-query measurement. It is not a fair uncached hybrid inference comparison.
The uncached semantic figure measures that same shared query inference path.

Initial index: 16 files, 95 chunks, 3,665 inferred tokens / 91 unique texts in
27.75 seconds, about 132 inferred tokens/second including setup/load and writes.
Peak sampled process RSS: 1,243 MiB. Index size after update exercises: 4.40 MB;
embedding memoization: 0.72 MB. The shared 639,150,592-byte model and 11.4 MB
tokenizer are additional one-time assets, not duplicated per project.

Reconciliation of unchanged source took 79 ms with zero new inference. Reopening
the persistent SQLite index in a new object likewise inferred nothing. The latter
is not a process-restart test; actual process/editor restart evidence is in the
integration artifacts. Rename reused a cached vector and removed the old path.

## Saved-file update scaling and unmet target

The initial tiny update test replaced 23 tokens and measured a 286 ms p95,
excluding watcher/debounce time. `scripts/benchmark_updates.py` exercises real
background notifications and committed vectors with five updates per size. The
final scaling run uses unique content at every size and records zero cache hits.
An earlier prefix-reuse run is retained as `updates-cached-prefix.json`, not used
as evidence of wholly new 1,000-token performance.

| New file tokens | Samples | Background update p95 |
| --- | ---: | ---: |
| 89 (budget 100) | 5 | 1.45 s |
| 500 | 5 | 8.25 s |
| 979 (budget 1,000) | 5 | 10.63 s |

These include Python's 500 ms debounce and polling to committed readiness, but
exclude the extension's additional 500 ms notification debounce. They were taken
on the working laptop during installation validation; CPU/thermal/IO variation
is visible. The ≤5-second target for wholly changed 1,000-token files is **not
met**. Existing completed chunks remain searchable and source verification drops
outdated excerpts during the update. The user can adjust token/thread budgets;
no unsupported performance promise is made.

## CPU choices

Public-API comparisons checked 2/4/8 threads and last-only token output. llama.cpp
overrides the latter because pooled embeddings require outputs for its input
tokens, so that experiment did not justify an implementation change. Four threads
remain the CPU budget default; eight logical threads gave a modest improvement.

A 1024-token native batch used roughly 2,084 MiB RSS on the larger sample versus
1,402 MiB at 512, with little speed benefit. The smaller default fits the intended
memory envelope and bounds interactive-query waiting. The indexing scheduler now
releases the shared inference turn after one native batch and rotates projects;
it does not reserve several long decodes under one background turn.

The conventional Transformers backend was evaluated from official documentation
but was not run in a timing comparison. The production backend is the measured
official GGUF CPU path. No GPU/cloud/remote inference or neural reranker is used.

To reproduce, run `scripts/benchmark.py`, `scripts/benchmark_updates.py`, and the
bounded CPU probes from the repository's standard CPython 3.13 environment after
explicit asset setup. Results are observations on this hardware and dataset;
very large repositories and sustained parallel editor usage need further sampling.
