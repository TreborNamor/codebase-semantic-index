"""Explicit, checksum-verified setup. Runtime inference never downloads assets."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

from .config import AppPaths
from . import __version__

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B-GGUF"
MODEL_REVISION = "370f27d7550e0def9b39c1f16d3fbaa13aa67728"
MODEL_FILE = "Qwen3-Embedding-0.6B-Q8_0.gguf"
MODEL_SHA256 = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
MODEL_SIZE = 639150592
MODEL_URL = f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{MODEL_FILE}"
TOKENIZER_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
TOKENIZER_FILE = "qwen3-tokenizer.json"
TOKENIZER_SHA256 = "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a"
TOKENIZER_SIZE = 11423705
TOKENIZER_URL = f"https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/{TOKENIZER_REVISION}/tokenizer.json"


def verified(path: Path, digest: str, size: int | None = None) -> bool:
    if not path.is_file() or (size is not None and path.stat().st_size != size):
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == digest


def download(url: str, target: Path, digest: str, size: int | None = None) -> None:
    if not url.startswith("https://"):
        raise ValueError("Setup assets require HTTPS")
    target.parent.mkdir(parents=True, exist_ok=True)
    if verified(target, digest, size):
        print(json.dumps({"asset": target.name, "status": "verified_cached"}), flush=True)
        return
    temporary = target.with_name(target.name + f".{os.getpid()}.part")
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={"User-Agent": f"CodeConverge/{__version__} setup"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as output:
            total = 0
            next_report = 64 * 1024 * 1024
            while block := source.read(2 * 1024 * 1024):
                output.write(block)
                total += len(block)
                if total >= next_report:
                    print(json.dumps({"asset": target.name, "downloaded_bytes": total, "total_bytes": size}), flush=True)
                    next_report += 64 * 1024 * 1024
            output.flush()
            os.fsync(output.fileno())
        if not verified(temporary, digest, size):
            raise RuntimeError(f"Checksum or size mismatch for {target.name}; asset was not activated")
        temporary.replace(target)
        print(json.dumps({"asset": target.name, "status": "verified_download", "bytes": total, "seconds": round(time.monotonic() - started, 3)}), flush=True)
    finally:
        temporary.unlink(missing_ok=True)


def setup_model(paths: AppPaths) -> Path:
    paths.initialize()
    target = paths.home / "models" / MODEL_FILE
    download(MODEL_URL, target, MODEL_SHA256, MODEL_SIZE)
    manifest = {"identity": MODEL_ID, "revision": MODEL_REVISION, "filename": MODEL_FILE, "sha256": MODEL_SHA256, "bytes": MODEL_SIZE}
    temporary = target.parent / "model.json.part"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target.parent / "model.json")
    return target


def setup_tokenizer(paths: AppPaths) -> Path:
    target = paths.home / "models" / TOKENIZER_FILE
    download(TOKENIZER_URL, target, TOKENIZER_SHA256, TOKENIZER_SIZE)
    return target
