# CodeConverge

Automatically connects trusted local Windows workspaces to CodeConverge's
session-scoped Python MCP server. Install the Python runtime once with the
application's PowerShell installer.

The Python engine runs Qwen3-Embedding-0.6B locally on CPU and combines semantic,
lexical and symbol retrieval. Background indexing, saved-file synchronization,
isolated persistent indexes and maintenance commands work across opened folders.
See the application README for installation, measurements and supported scope.

The extension activates at startup, obtains roots from VS Code workspace APIs,
and registers one MCP provider per window. Closing a window revokes its session.
Source code is never selected from an inferred working directory.
