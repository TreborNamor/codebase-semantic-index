"""Offline Qwen token budgets, with an explicit conservative lexical fallback."""
from __future__ import annotations

import math
from bisect import bisect_right
from pathlib import Path

from .assets import TOKENIZER_FILE, TOKENIZER_SHA256, verified


class TokenCounter:
    def __init__(self, home: Path):
        self.tokenizer = None
        path = home / "models" / TOKENIZER_FILE
        if verified(path, TOKENIZER_SHA256):
            from tokenizers import Tokenizer
            self.tokenizer = Tokenizer.from_file(str(path))
        self.identity = TOKENIZER_SHA256 if self.tokenizer else "conservative-utf8-budget-v1"
        self.warnings = set() if self.tokenizer else {"Qwen tokenizer is unavailable; conservative token estimates are active. Run CodeConverge setup."}

    @property
    def exact(self) -> bool:
        return self.tokenizer is not None

    def count(self, text: str) -> int:
        if self.tokenizer:
            return len(self.tokenizer.encode(text, add_special_tokens=False).ids)
        return max(1, math.ceil(len(text.encode("utf-8")) / 2))

    def prefix(self, text: str, budget: int) -> str:
        if self.tokenizer:
            encoded = self.tokenizer.encode(text, add_special_tokens=False)
            if len(encoded.ids) <= budget:
                return text
            end = encoded.offsets[budget - 1][1]
            while end > 0 and len(self.tokenizer.encode(text[:end], add_special_tokens=False).ids) > budget:
                end -= 1
            return text[:end]
        return text[:max(1, budget)]

    def windows(self, text: str, budget: int):
        """Last resort for a single structural leaf too large for one chunk."""
        if self.tokenizer:
            offsets = self.tokenizer.encode(text, add_special_tokens=False).offsets
            ends = [pair[1] for pair in offsets]
            start = 0
            index = 0
            while start < len(text):
                last = min(index + budget - 1, len(ends) - 1)
                end = max(start + 1, ends[last])
                while end > start + 1 and self.count(text[start:end]) > budget:
                    end -= 1
                yield start, end
                start = end
                index = bisect_right(ends, start)
        else:
            # Prefer statement/line splitting in the chunker before this leaf
            # fallback. This path is labeled approximate until setup completes.
            start = 0
            for end in range(max(1, budget), len(text), max(1, budget)):
                yield start, end
                start = end
            if start < len(text):
                yield start, len(text)
