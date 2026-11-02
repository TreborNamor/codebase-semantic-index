# Installation on another computer

The Git repository contains the complete Windows source installation path. You
do not need the original development computer, its Python environment, its model
cache or its indexes for an online installation. The installer creates a separate
user-level application; the checkout is only used to build and install it.

## Prerequisites

Install these on the destination computer before starting:

- Windows x64 and PowerShell 7 or later, launched as `pwsh`.
- Standard 64-bit CPython 3.13 with the `py` launcher. Free-threaded Python,
  Python 3.14 and other Python minor versions are outside this release's lock.
- Git and Node.js 24 with npm for the source build.
- VS Code 1.144 or later with its `code` command on PATH, plus authenticated
  GitHub Copilot access using the Copilot harness.
- Internet access for the initial package, model and grammar downloads.

Use PowerShell 7 to check the commands before cloning:

```powershell
$PSVersionTable.PSVersion
py -3.13 -c "import sys, struct; print(sys.executable); print(sys.version); print(struct.calcsize('P') * 8)"
git --version
node --version
npm.cmd --version
code.cmd --version
```

The Python command should report version 3.13 and 64 bits. This release has been
validated on Windows; macOS, Linux, WSL, SSH and container integration have not
been implemented or validated.

## Build and install once

```powershell
git clone https://github.com/TreborNamor/codebase-semantic-index.git
cd codebase-semantic-index
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\scripts\build.ps1
.\scripts\install.ps1
```

Stop if a command fails. The build creates the Python wheel and extension VSIX
under `dist`; these generated files are not committed. The installer uses
`py -3.13` to find Python, falling back to `python.exe` if the launcher is absent.
An explicit executable can also be supplied:

```powershell
.\scripts\install.ps1 -Python .\.venv\Scripts\python.exe
```

If script execution is blocked on your computer, invoke the individual script
with a policy applying only to that PowerShell process:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Installation creates a dedicated runtime under your local application data,
verifies the Qwen GGUF/tokenizer and parser assets, installs the VSIX with
`code.cmd`, and copies the managed Copilot instructions and custom agent to your
user profile. It preserves customized guidance files and uses `COPILOT_HOME`
when supplied. No project-specific MCP setup or workspace path is required.

Initial setup downloads the 639 MB Qwen GGUF, tokenizer, grammars and runtime
dependencies. Subsequent indexing and inference use the local assets. Existing
indexes from the old computer are unnecessary: each new machine builds and
retains its own indexes for the folders opened there.

## Verify first use

1. Reload already-open VS Code windows after installation.
2. Use **File → Open Folder** to open a trusted local source folder.
3. Watch CodeConverge's status move from **Indexing** to **Ready**, or use
   **CodeConverge: Show Status** to inspect progress and errors.
4. In Copilot, request: “Use CodeConverge index_status, then find the definition
   of [a symbol that exists in this folder].” Confirm the returned root and file.
5. Open another trusted project and repeat. Results must belong to that folder.

The installed `codeconverge-research` custom agent permits the MCP tools. Other
custom agents with explicit tool lists must permit them too. Copilot Auto was
validated on the development computer; the user's Haiku model must be checked
on the destination computer where it is available.

## Offline transfer

On a prepared online Windows computer, build the application, install it once
to obtain verified assets, and run:

```powershell
.\scripts\bundle.ps1
```

Copy the entire `dist/offline-0.2.0` folder to the destination, including its
`scripts`, `dist`, `wheelhouse`, `assets`, `integration` and dependency lock files.
The destination still needs PowerShell 7, standard x64 CPython 3.13 and VS Code;
Git and Node are unnecessary for this prebuilt route. In the copied bundle run:

```powershell
.\scripts\install.ps1 -Offline -Wheelhouse .\wheelhouse -AssetsDirectory .\assets
```

The bundle contains checksums; installation enforces dependency hashes and asset
verification. The repository itself does not contain this large generated bundle.
See [maintenance and troubleshooting](MAINTENANCE.md) for upgrades and removal.
