from dataclasses import replace

import numpy as np
import pytest

from codeconverge.embeddings import EmbeddingCache
from codeconverge.settings import Settings


@pytest.mark.parametrize("text", [
    '[files]\nexcludes="*.log"',
    '[embedding]\nidle_seconds=nan',
    '[index]\nreconcile_seconds=inf',
    '[embedding]\ndimensions=2048',
    '[files]\nrespect_gitignore="yes"',
    '[unknown]\nvalue=1',
    '[projects.relative]\nexcludes=["*.log"]',
])
def test_invalid_user_configuration_fails_clearly(tmp_path, text):
    directory = tmp_path / "config"
    directory.mkdir()
    (directory / "settings.toml").write_text(text, encoding="utf-8")
    with pytest.raises(ValueError):
        Settings.load(tmp_path)


def test_cache_corruption_recovery_and_invalid_vectors_are_not_hits(tmp_path):
    path = tmp_path / "embeddings.sqlite"
    cache = EmbeddingCache(path, 32, 1)
    vector = np.ones(32, dtype=np.float32) / np.sqrt(32)
    cache.put({"good": vector, "zero": np.zeros(32, dtype=np.float32)})
    assert set(cache.get(["good", "zero"])) == {"good"}
    path.write_bytes(b"damaged derived cache")
    assert cache.get(["good"]) == {}
    assert cache.warnings
    cache.put({"new": vector})
    assert "new" in cache.get(["new"])
