"""Bounded process-local response cache."""
from collections import OrderedDict
import threading
import time


class ResponseCache:
    def __init__(self, capacity=100):
        self.capacity = capacity
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        """Discard expired values and promote a hit to most recently used."""
        with self.lock:
            value = self.entries.get(key)
            if value is None:
                return None
            expires, payload = value
            if expires < time.monotonic():
                del self.entries[key]
                return None
            self.entries.move_to_end(key)
            return payload

    def put(self, key, value, ttl=60):
        """Evict the least recently accessed response when capacity is exceeded."""
        with self.lock:
            self.entries[key] = (time.monotonic() + ttl, value)
            self.entries.move_to_end(key)
            while len(self.entries) > self.capacity:
                self.entries.popitem(last=False)


def cache_key(tenant_id, route, parameters):
    """Partition cached responses by tenant and stable query parameters."""
    return tenant_id, route, tuple(sorted(parameters.items()))
