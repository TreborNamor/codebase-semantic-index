"""Download exact Windows runtime wheels and lock their actual SHA-256 digests."""

from pathlib import Path
import hashlib
import subprocess
import sys

from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.requirements import Requirement


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    wheelhouse = root / "dist" / "wheelhouse"
    wheelhouse.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--no-deps", "--dest", str(wheelhouse), "-r", str(root / "requirements-runtime.txt")], check=True)
    wheels = {}
    for file in wheelhouse.glob("*.whl"):
        name, version, _, _ = parse_wheel_filename(file.name)
        wheels[(canonicalize_name(name), str(version))] = file
    lines = ["# Tested Windows x64 CPython 3.13 runtime wheel hashes. Regenerate with scripts/lock_dependencies.py."]
    for requirement in (root / "requirements-runtime.txt").read_text().splitlines():
        if not requirement or requirement.startswith("#"):
            continue
        parsed = Requirement(requirement)
        name = parsed.name
        if parsed.url:
            version = str(parse_wheel_filename(parsed.url.rsplit("/", 1)[-1])[1])
        else:
            version = next(iter(parsed.specifier)).version
        file = wheels[(canonicalize_name(name), version)]
        digest = hashlib.file_digest(file.open("rb"), "sha256").hexdigest()
        pinned = f"{name} @ {parsed.url}" if parsed.url else f"{name}=={version}"
        lines.append(f"{pinned} --hash=sha256:{digest}")
    (root / "requirements.lock").write_text("\n".join(lines) + "\n", encoding="utf-8")
    offline = [line if not line.startswith("llama-cpp-python @ ") else "llama-cpp-python==0.3.19 --hash=" + line.split(" --hash=", 1)[1] for line in lines]
    (root / "requirements-offline.lock").write_text("\n".join(offline) + "\n", encoding="utf-8")
    print(f"Locked {len(lines) - 1} actual runtime wheels.")


if __name__ == "__main__":
    main()
