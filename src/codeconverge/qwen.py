"""Qwen GGUF CPU inference through the supported llama.cpp C API.

The high-level Python wrapper defaults to a one-sequence context. We configure
sequence capacity explicitly so embedding batches remain isolated and valid.
"""
from __future__ import annotations

import ctypes
import logging
import threading
import time
from pathlib import Path

import numpy as np

from .assets import MODEL_SHA256, MODEL_SIZE, verified
from .settings import EmbeddingSettings

_initialization_lock = threading.Lock()
_initialized = False
_log_callback = None


class QwenBackend:
    def __init__(self, path: Path, settings: EmbeddingSettings):
        import llama_cpp as lib
        self.lib = lib
        self.settings = settings
        self.model = None
        self.context = None
        self.batch = None
        self.last_used = time.monotonic()
        if not verified(path, MODEL_SHA256, MODEL_SIZE):
            raise RuntimeError("The verified Qwen Q8_0 model is missing. Run CodeConverge setup once.")
        global _initialized
        with _initialization_lock:
            if not _initialized:
                global _log_callback
                @lib.llama_log_callback
                def callback(level, message, user_data):
                    if level in (3, 4):
                        logging.getLogger("codeconverge.qwen").log(logging.WARNING if level == 3 else logging.ERROR,
                            message.decode("utf-8", errors="replace").strip())
                _log_callback = callback
                lib.llama_log_set(callback, None)
                lib.llama_backend_init()
                _initialized = True
        try:
            model_params = lib.llama_model_default_params()
            model_params.n_gpu_layers = 0
            model_params.use_mmap = True
            self.model = lib.llama_model_load_from_file(str(path).encode("utf-8"), model_params)
            if not self.model:
                raise RuntimeError("llama.cpp could not load the verified Qwen model")
            self.native_dimensions = lib.llama_model_n_embd(self.model)
            if self.native_dimensions != 1024:
                raise RuntimeError("Unexpected Qwen embedding dimension")
            self.vocab = lib.llama_model_get_vocab(self.model)
            self.metadata = {}
            for key in ["general.architecture", "general.file_type", "qwen3.pooling_type",
                        "tokenizer.ggml.add_bos_token", "tokenizer.ggml.add_eos_token"]:
                buffer = ctypes.create_string_buffer(256)
                if lib.llama_model_meta_val_str(self.model, key.encode(), buffer, len(buffer)) >= 0:
                    self.metadata[key] = buffer.value.decode("utf-8", errors="replace")
            params = lib.llama_context_default_params()
            params.n_ctx = settings.batch_tokens * settings.batch_sequences
            params.n_batch = settings.batch_tokens
            params.n_ubatch = settings.batch_tokens
            params.n_seq_max = settings.batch_sequences
            params.n_threads = settings.threads
            params.n_threads_batch = settings.threads
            params.embeddings = True
            params.pooling_type = lib.LLAMA_POOLING_TYPE_LAST
            params.offload_kqv = False
            params.op_offload = False
            self.context = lib.llama_init_from_model(self.model, params)
            if not self.context:
                raise RuntimeError("llama.cpp could not allocate the CPU embedding context")
            self.batch = lib.llama_batch_init(settings.batch_tokens, 0, 1)
            if not self.batch.token:
                raise RuntimeError("llama.cpp could not allocate an embedding batch")
        except BaseException:
            self.close()
            raise

    def tokenize(self, text: str) -> list[int]:
        encoded = text.encode("utf-8")
        capacity = len(encoded) + 8
        tokens = (ctypes.c_int32 * capacity)()
        count = self.lib.llama_tokenize(self.vocab, encoded, len(encoded), tokens, capacity, True, False)
        if count < 0:
            capacity = -count
            tokens = (ctypes.c_int32 * capacity)()
            count = self.lib.llama_tokenize(self.vocab, encoded, len(encoded), tokens, capacity, True, False)
        if count <= 0:
            raise RuntimeError("Qwen tokenizer produced no tokens")
        return list(tokens[:count])

    def embed(self, texts: list[str]) -> tuple[np.ndarray, int]:
        if not texts:
            return np.empty((0, self.settings.dimensions), dtype=np.float32), 0
        prepared = [self.tokenize(text) for text in texts]
        if any(len(tokens) > self.settings.batch_tokens for tokens in prepared):
            raise ValueError("Embedding input exceeds its configured token budget; rechunk the source")
        result = []
        group: list[list[int]] = []
        count = 0
        for tokens in prepared:
            if group and (count + len(tokens) > self.settings.batch_tokens or len(group) >= self.settings.batch_sequences):
                result.extend(self._decode(group))
                group, count = [], 0
            group.append(tokens)
            count += len(tokens)
        if group:
            result.extend(self._decode(group))
        self.last_used = time.monotonic()
        return np.asarray(result, dtype=np.float32), sum(map(len, prepared))

    def _decode(self, group: list[list[int]]) -> list[np.ndarray]:
        lib = self.lib
        lib.llama_memory_clear(lib.llama_get_memory(self.context), True)
        batch = self.batch
        offset = 0
        for sequence, tokens in enumerate(group):
            for position, token in enumerate(tokens):
                batch.token[offset] = token
                batch.pos[offset] = position
                batch.n_seq_id[offset] = 1
                batch.seq_id[offset][0] = sequence
                batch.logits[offset] = True
                offset += 1
        batch.n_tokens = offset
        code = lib.llama_decode(self.context, batch)
        if code != 0:
            raise RuntimeError(f"llama.cpp embedding decode failed ({code})")
        result = []
        for sequence in range(len(group)):
            pointer = lib.llama_get_embeddings_seq(self.context, sequence)
            if not pointer:
                raise RuntimeError("llama.cpp returned no pooled sequence embedding")
            vector = np.ctypeslib.as_array(pointer, shape=(self.native_dimensions,))[:self.settings.dimensions].copy()
            norm = float(np.linalg.norm(vector))
            if not np.isfinite(vector).all() or norm < 1e-12:
                raise RuntimeError("Qwen returned an invalid embedding")
            result.append(vector / norm)
        return result

    def close(self) -> None:
        if self.batch is not None:
            self.lib.llama_batch_free(self.batch)
            self.batch = None
        if self.context:
            self.lib.llama_free(self.context)
            self.context = None
        if self.model:
            self.lib.llama_model_free(self.model)
            self.model = None
