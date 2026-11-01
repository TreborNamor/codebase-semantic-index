# Codebase Semantic Index

A VS Code extension that searches the files in your current workspace using local Qwen3 embeddings and exact identifier/path matching. It does not traverse commits, index other branches, or query a remote repository search service.

The retrieval contract is: **every returned code excerpt comes from an eligible file in the current workspace, using the current editor contents when unsaved changes exist.** Source is verified at retrieval time; always re-read it before editing.

## Get started

1. Install the extension and open your project or multi-root workspace.
2. Open VS Code without triggering model downloads or indexing in the background. Use **Codebase Semantic Index: Build Index** (or the Activity Bar panel) when you want to create or rebuild the index. The model loads then, followed by indexing. Searching an existing index loads the model on the first semantic query. After the model is active, file changes reconcile automatically. Inference runs locally using q8 WASM after the first model download. This release uses a consistent single-threaded WASM backend instead of attempting unsupported quantized WebGPU operations.
3. Open Copilot Chat and select **Agent** mode.
4. Check that **Codebase Semantic Index: Semantic Search** is enabled in the active agent's tool selection, as described below. If it is already enabled, no additional toggle is needed.
5. Ask a codebase question normally; you do not need to mention the tool in every prompt. For example:

   ```text
   Find how failed indexing operations are retried.
   Verify the relevant current source ranges before proposing a change.
   ```

Copilot's built-in semantic index can remain disabled. This extension does not change your Copilot settings, model selection, billing, or permissions.

### Enable the tool in Copilot Agent mode

**The tool must be available and enabled for the active agent before Copilot can call it.** Installing the extension or building an index does not by itself confirm that the agent's tool selection includes it.

- **Copilot harness:** run **Chat: Open Customizations**, select **Tools**, find **Codebase Semantic Index: Semantic Search**, and ensure it is checked. This selection persists in the active user profile.
- **Local harness:** select **Agent**, open **Configure Tools** in the chat input, and ensure **Codebase Semantic Index: Semantic Search** is checked for the request.
- **Custom agents:** if the agent defines a restricted `tools` list, include this extension's search tool using the agent editor's tool picker. Check the selected agent's effective tools rather than assuming another agent's selection applies.

Once enabled, Copilot can select the tool automatically based on the task and its instructions. This project's [Copilot instructions](.github/copilot-instructions.md) tell it when to prefer semantic discovery and when to use exact local lookup. Instruction files guide tool selection; they cannot enable a disabled tool or guarantee invocation on every message. To request it explicitly, use `#codebaseSemanticIndex`.

Expand a tool call in the conversation to confirm that Copilot invoked **Codebase Semantic Index: Semantic Search** (`codebase_semantic_index_search`). See the official [tool-selection documentation](https://code.visualstudio.com/docs/agents/run/tools) for interface and harness details. Tool availability is separate from approval: enabling it does not bypass your permission controls.

## Refine a prompt before sending it to Copilot

Open the extension's Activity Bar panel, or run **Codebase Semantic Index: Refine Prompt** from the Command Palette. The wand button in the extension view's title bar focuses the same composer.

1. Write your request in **Your draft**.
2. Click **Refine Prompt**. On first use, choose a model exposed by Copilot's Language Model API. The extension remembers this choice; **Change model** lets you select another. This selection is separate from the coding agent's model.
3. Review and optionally edit the **Revised prompt**. The refiner is instructed to improve clarity while preserving your intent, requirements, constraints, language, technical details, and literal references. Model rewrites can make mistakes; review before use.
4. Click **Insert into Copilot**. This replaces Copilot's current input with the revised text as an **unsent draft**. It does not execute the request, switch the agent/model, or transfer file attachments. Press Send in Copilot when ready. **Copy** is available as an alternative.

Each refinement is a separate model request subject to your Copilot access and usage allowance. The extension sends only the entered draft and concise rewriting instructions, with no workspace source, conversation history, semantic retrieval, or tools. It does not contact Gemini or require a separate API key. VS Code may ask for consent before the extension can use a Copilot model. If no models are exposed to the extension, check Copilot sign-in and model access; availability can differ from the chat model picker.

Typing does not trigger a model call. Drafts and reviewed text are saved locally as webview state. Refinements are limited to 12,000 draft characters and a 4,096-token input budget (or the model's smaller limit), with a 90-second timeout and bounded response handling. Editing the draft or clicking **Cancel** cancels the active refinement; late responses cannot replace a newer draft. Failures keep your original draft.

The composer lives in its own **Prompt Refinement** Activity Bar container, separate from **Codebase Semantic Index** (which contains the index panel and embedding worker). VS Code does not expose a public API to read Copilot's unsent input or add a custom button directly inside it. Insertion uses the VS Code chat command with `isPartialQuery: true`; if insertion is unavailable in your host, use **Copy**. Refinement does not require a workspace index or the semantic-search tool to be enabled.

## How current-file retrieval works

- Each workspace root has separate state and storage, identified by its complete URI, including scheme and remote authority. Separate worktrees do not share an index just because they use the same repository or branch name.
- A saved-file manifest records content hashes. Reconciliation discovers changed/new files, removes deleted or newly excluded files, and reuses unchanged embeddings. File changes received during a build remain queued.
- Unsaved documents form a transient overlay. Search validates indexed content against live files and buffers, suppresses stale embeddings, and returns current-file lexical matches while updates are pending.
- Long functions and module-level gaps are split into bounded source chunks instead of being truncated. Results include precise source ranges.
- Identifier/path/text rankings and vector similarity are fused, and overlapping results are deduplicated. Similarity is not a probability or a percentage match.
- Model failures, invalid vectors, and incompatible indexes are reported explicitly. When semantic search is unavailable, the tool identifies its current-file lexical fallback; a zero-vector embedding is never treated as success.

Indexes live under `.codebase-semantic-index/` within each root. Immutable data/vector generations are published through a committed manifest with integrity hashes so readers do not mix generations. Old generations are retained to avoid deleting files used by another open window. Indexes from older releases, another root, or a different embedding/chunker configuration must be rebuilt from current files; historical previews are not trusted or migrated into fresh results. Use **Build Index** to rebuild.

Eligibility respects supported text/code file types, nested `.gitignore` files, and each root's VS Code file/search exclusions, together with built-in exclusions for Git metadata, index storage, dependencies, and generated output. Files larger than 1 MiB, binary contents, and symbolic links are skipped. Ignored files do not become eligible merely because they are open. Review exclusions when an expected file is absent.

Local embeddings do not make Copilot chat offline: excerpts returned to an agent become part of its model context. The extension does not control evidence obtained through the agent's other tools or previous conversation history. Start a fresh chat after switching away from a conversation containing obsolete branch references.

## Search tool

The registered tool name remains `codebase_semantic_index_search`, with the prompt reference `#codebaseSemanticIndex`.

| Input | Behavior |
|---|---|
| `query` | Required natural-language description or code identifier. |
| `maxResults` | Optional integer; defaults to 5 and is bounded to 1–20. |
| `pathPrefix` | Optional literal workspace-relative file or directory, such as `src/services`; applied inside each root. Absolute paths, URIs, and parent traversal are rejected. |

Results identify their workspace root, relative file path, symbol when available, exact excerpt range, and a short current source excerpt. The tool honors VS Code's supplied output-token budget when available, so it can return fewer results than requested. Use semantic retrieval for concept discovery, local text/symbol search for known names, and narrow source reads before editing.

## Optional current-workspace agent

This repository includes [Current Workspace](.github/agents/current-workspace.agent.md), an opt-in custom agent for VS Code's **Local harness**, which can use your selected Copilot model. Select the Local harness and then the agent in the chat picker. `target: vscode` controls file interpretation; it does not switch harnesses for you. To use the profile in another project, copy the file into that project's `.github/agents/` directory.

The profile allows this extension and individual local read, text/file/symbol search, edit, and terminal tools. It omits the broad `search` group because that group can include built-in semantic codebase search. Confirm the extension's qualified tool reference using the agent editor's tool completions after installation, especially if you change the publisher identity. The prompt reference remains `#codebaseSemanticIndex`.

Tool identifiers differ between Local and Copilot harnesses. For a Copilot-harness profile, use its tool-picker completions to select this extension and the required local capabilities. Do not copy Local tool identifiers blindly. See the official [custom-agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference) and [tool reference](https://code.visualstudio.com/docs/agents/reference/tools-reference).

The profile is a workflow preference, not a sandbox: terminal commands can access other paths, network resources, or Git history. Existing approval controls remain in force. Its instructions limit source discovery to current workspace files unless you explicitly request other evidence.

## Development

Use a current Node.js LTS release with npm:

```sh
npm install
npm test
npm run typecheck
npm run compile-web
npm run test:web
npm run test:refiner-ui
npm run run-in-browser
```

`test:web` requires an existing extension bundle from `compile-web` or `package-web`. It runs the real extension and public tool in a headless VS Code web host with model downloads blocked, checking saved files, checkout replacement, unsaved edits, ignore changes, and deletion. It validates lexical fallback rather than model inference. `run-in-browser` opens an interactive VS Code web development host. Copilot integration additionally requires a signed-in host with Copilot and this extension's tool enabled. Create a production bundle or an installable VSIX with:

```sh
npm run package-web
npx vsce package
```

## Evaluate correctness and cost

First verify branch switches with unchanged filenames, deleted/newly ignored files, unsaved edits, edits during builds, separate roots/worktrees, and embedding failure. No stale or cross-root source should be returned as a current excerpt.

Then record 30 real queries covering identifiers, paths, behavior descriptions, imports, long-function tails, recent edits, and absent functionality. For repeatable coding tasks, record correct completion, whether the right result appeared in the first five hits, later searches/file-read tokens, latency, and total Copilot AI credits from Agent Debug Logs. Change one retrieval setting at a time and repeat representative tasks. Compare **cost per successful task**, rather than index size or one search response. This project makes no measured token-saving claim until those evaluations have been run.
