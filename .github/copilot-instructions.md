# Current-workspace code retrieval

When available and enabled, invoke Codebase Semantic Index
(`codebase_semantic_index_search`, prompt reference `#codebaseSemanticIndex`)
automatically when discovering relevant workspace implementation. Do not wait
for the user to mention the tool.

## Choose the appropriate lookup

- Prefer this tool for behavior or concept questions when the implementation
  location is unknown, such as finding retry logic or tracing a feature's entry
  points. Describe the behavior and include relevant code terms in `query`.
- Use local text, file, or symbol search directly for known identifiers, exact
  strings, filenames, definitions, and references. Follow discovered symbols
  with usages/definition tools when tracing relationships.
- Skip discovery searches when supplied context or already-read current source
  is sufficient. Read a known relevant file directly instead of searching again.

## Keep retrieval focused and verify the evidence

- Start with the default five results. Supply `pathPrefix` when a relevant file
  or directory is known; it is a literal workspace-relative path applied within
  each root, not a glob or absolute path. Increase `maxResults` only when needed
  (supported range: 1–20), or refine the query before repeating a search.
- Check the returned workspace root, path, and range. Read the necessary current
  source around the excerpt before editing; include unsaved editor contents.
  Re-read affected source after a checkout or intervening edit. Excerpts can be
  incomplete, and rank scores are ordering signals, not confidence percentages.
- Read status messages. A first search may load Qwen and reconcile the index.
  If indexing or embedding is unavailable, the tool returns no lexical fallback
  results. Use focused local searches to fill gaps. Do not repeatedly retry a
  failing tool; report a persistent availability/indexing problem when relevant.
- Empty or shortened output does not prove functionality is absent: exclusions,
  pending indexing, unavailable embeddings, and output-token limits can omit matches.

Use current-workspace source as implementation evidence. Use built-in semantic
codebase search, remote repository search, other checkouts, or historical source
only when explicitly requested. If this tool is unavailable, use local text,
file, and symbol search instead.

Stop exploration once the evidence is sufficient. Run validation appropriate to
the change and report changed files, validation results, and blockers concisely;
do not repeat code already edited.
