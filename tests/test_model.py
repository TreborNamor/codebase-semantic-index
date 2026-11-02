from pathlib import Path
import socket

import numpy as np
import pytest

from codeconverge.assets import MODEL_FILE
from codeconverge.config import AppPaths
from codeconverge.embeddings import EmbeddingProvider
from codeconverge.settings import EmbeddingSettings


@pytest.mark.model
def test_real_cpu_offline_batch_normalization_and_persistent_cache(tmp_path, monkeypatch):
    model = AppPaths.default().home / "models" / MODEL_FILE
    if not model.is_file():
        pytest.skip("Run codeconverge setup once to enable real-model tests")
    def deny(*_args, **_kwargs):
        raise AssertionError("Inference attempted network access")
    monkeypatch.setattr(socket, "socket", deny)
    monkeypatch.setattr(socket, "create_connection", deny)
    settings = EmbeddingSettings()
    paths = AppPaths(tmp_path / "app")
    provider = EmbeddingProvider(paths, settings, model_path=model)
    texts = ["def dashboard_filters(): return selected_region", "def invoice_total(): return sum(line.amount for line in lines)"]
    try:
        vectors, stats = provider.embed(texts)
        assert stats["inferred_texts"] == 2 and provider.loaded
        assert np.asarray(vectors).shape == (2, 1024)
        assert np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5)
        cached, stats = provider.embed(texts)
        assert stats["cache_hits"] == 2 and stats["inferred_texts"] == 0
        assert np.array_equal(cached, vectors)
    finally:
        provider.unload_if_idle(force=True)
    reopened = EmbeddingProvider(paths, settings, model_path=model)
    result, stats = reopened.embed(texts)
    assert stats["cache_hits"] == 2 and not reopened.loaded
    assert np.array_equal(result, vectors)
