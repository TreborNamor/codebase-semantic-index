"""Bounded public-API CPU comparison; does not modify retrieval or its labels."""
from pathlib import Path
import json
import time

import numpy as np

from codeconverge.assets import MODEL_FILE
from codeconverge.chunking import Chunker
from codeconverge.config import AppPaths
from codeconverge.parsers import ParserLibrary
from codeconverge.qwen import QwenBackend
from codeconverge.scanning import SourceFile
from codeconverge.settings import EmbeddingSettings
from codeconverge.tokenization import TokenCounter

assets = AppPaths.default().home
counter = TokenCounter(assets)
chunker = Chunker(ParserLibrary(assets / 'parsers'), counter)
lines = []
while True:
    proposed = [*lines, f'    value = (value * {len(lines) + 2} + 1) % 1000003\n']
    text = 'def transform_events(value):\n' + ''.join(proposed) + '    return value\n'
    if counter.count(text) > 1000:
        break
    lines = proposed
text = 'def transform_events(value):\n' + ''.join(lines) + '    return value\n'
chunks = chunker.chunk('a' * 32, SourceFile('events.py','python',text,'hash',len(text),0,'inode'))
texts = [c.embedding_text for c in chunks]
backend = QwenBackend(assets / 'models' / MODEL_FILE, EmbeddingSettings())
rows = []
baseline = None
decode = backend.lib.llama_decode
try:
    for threads, last_only in [(4,False),(4,True),(2,True),(8,True),(4,True)]:
        backend.lib.llama_set_n_threads(backend.context,threads,threads)
        def selected_decode(context, batch):
            for i in range(batch.n_tokens):
                batch.logits[i] = i + 1 == batch.n_tokens or batch.seq_id[i][0] != batch.seq_id[i+1][0]
            return decode(context,batch)
        backend.lib.llama_decode = selected_decode if last_only else decode
        started = time.perf_counter()
        vectors, tokens = backend.embed(texts)
        elapsed = time.perf_counter() - started
        if baseline is None: baseline = vectors
        row = {'threads':threads,'last_token_output_only':last_only,'seconds':elapsed,'tokens':tokens,
            'minimum_baseline_cosine':float(np.min(np.sum(baseline*vectors,axis=1)))}
        rows.append(row)
        print(json.dumps(row),flush=True)
finally:
    backend.lib.llama_decode = decode
    backend.close()
output = Path(__file__).resolve().parent.parent / 'artifacts/benchmarks/cpu-options.json'
output.write_text(json.dumps({'real_model':True,'rows':rows},indent=2)+'\n')
