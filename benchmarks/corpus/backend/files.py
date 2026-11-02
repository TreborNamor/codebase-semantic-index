"""User-provided document handling."""
from pathlib import Path
import os
import tempfile


def resolve_upload(root, relative):
    candidate = (Path(root) / relative).resolve()
    if not candidate.is_relative_to(Path(root).resolve()):
        raise PermissionError('Document path escapes the upload directory')
    return candidate


def write_atomic(destination, content):
    """Readers see the previous complete file or the new complete file."""
    destination = Path(destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fsync(temporary.fileno())
        staged = temporary.name
    os.replace(staged, destination)


def validate_upload(name, content, limit=5_000_000):
    """Reject oversized documents and unsupported attachment formats."""
    if len(content) > limit:
        raise ValueError('Attachment too large')
    if Path(name).suffix.lower() not in {'.pdf', '.txt', '.csv'}:
        raise ValueError('Unsupported document format')
    return True
