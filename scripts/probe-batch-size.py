"""Compare real CPU batch budgets on identical independent structural chunks."""
from dataclasses import replace
from pathlib import Path
import json
import time

import numpy as np
import psutil

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
chunker = Chunker(ParserLibrary(assets / 'parsers'),counter)
text = 'def transform_events(value):\n' + ''.join(f'    value = (value * {i+2} + 10001) % 1000003\n' for i in range(35)) + '    return value\n'
while counter.count(text) > 1000:
    lines = text.splitlines(keepends=True)
    text = ''.join([*lines[:-2],lines[-1]])
texts = [c.embedding_text for c in chunker.chunk('a'*32, SourceFile('events.py','python',text,'hash',len(text),0,'inode'))]
rows, baseline = [], None
for batch, threads in [(512,4),(1024,4),(1024,8),(512,4)]:
    model = QwenBackend(assets / 'models' / MODEL_FILE, replace(EmbeddingSettings(),batch_tokens=batch,threads=threads))
    try:
        model.embed(['Warm the CPU embedding execution path.'])
        started = time.perf_counter()
        vectors,tokens = model.embed(texts)
        seconds = time.perf_counter()-started
        if baseline is None: baseline=vectors
        row={'batch_tokens':batch,'threads':threads,'tokens':tokens,'seconds':seconds,
            'minimum_baseline_cosine':float(np.min(np.sum(vectors*baseline,axis=1))),
            'process_rss_mib':psutil.Process().memory_info().rss/1024**2}
        rows.append(row)
        print(json.dumps(row),flush=True)
    finally: model.close()
output=Path(__file__).resolve().parent.parent/'artifacts/benchmarks/batch-options.json'
output.write_text(json.dumps({'real_model':True,'chunks':len(texts),'rows':rows},indent=2)+'\n')
