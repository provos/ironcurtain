"""Cross-process file locking helpers for the Evolve skill runtime."""

from __future__ import annotations

import os
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class InterProcessFileLock:
    """Hold an exclusive lock on a sentinel file across processes."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._handle = None

    def __enter__(self) -> "InterProcessFileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = open(self.path, "a+b")
        self._handle.seek(0)
        self._handle.write(b"\0")
        self._handle.flush()
        self._handle.seek(0)

        if os.name == "nt":
            msvcrt.locking(self._handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._handle is None:
            return

        self._handle.seek(0)
        if os.name == "nt":
            msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        self._handle.close()
        self._handle = None
