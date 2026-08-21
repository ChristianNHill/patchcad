"""Warm worker pool. Each worker is a spawned process holding a live
build123d interpreter; the parent stays OCP-free so a native crash can only
take down one worker. Timeouts get SIGKILL, crashes get respawned, and both
come back as structured, repairable errors instead of a dead service.
"""

from __future__ import annotations

import multiprocessing as mp
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .worker import worker_main

SPAWN = mp.get_context("spawn")
BOOT_TIMEOUT_S = 120  # first build123d import can be slow on cold caches


class WorkerCrash(Exception):
    pass


class WorkerTimeout(Exception):
    pass


class Worker:
    def __init__(self) -> None:
        self.respawns = 0
        self._start()

    def _start(self) -> None:
        self.parent_conn, child_conn = SPAWN.Pipe()
        self.process = SPAWN.Process(target=worker_main, args=(child_conn,), daemon=True)
        self.process.start()
        child_conn.close()
        # The child is already running by here, so a boot failure has to reap it:
        # the constructor throws, no caller holds the half-built Worker, and
        # daemon=True only covers a clean interpreter exit — leaving an orphan
        # holding a live OCP interpreter.
        try:
            if not self.parent_conn.poll(BOOT_TIMEOUT_S):
                raise RuntimeError("kernel worker failed to become ready (build123d import hang?)")
            ready = self.parent_conn.recv()
            if not ready.get("ready"):
                raise RuntimeError(f"kernel worker sent unexpected boot message: {ready}")
        except BaseException:
            try:
                self.process.kill()
                self.process.join(5)
            except Exception:  # noqa: BLE001
                pass
            raise

    def request(self, job: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        """Blocking send+recv. Raises WorkerTimeout / WorkerCrash; either way
        the caller must consider this worker dead and call respawn()."""
        try:
            self.parent_conn.send(job)
        except (BrokenPipeError, OSError) as err:
            raise WorkerCrash(f"worker pipe broken before send: {err}") from None
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.parent_conn.poll(0.1):
                try:
                    return self.parent_conn.recv()
                except (EOFError, OSError) as err:
                    raise WorkerCrash(f"worker died mid-job: {err}") from None
            if not self.process.is_alive():
                raise WorkerCrash(f"worker exited with code {self.process.exitcode}")
        raise WorkerTimeout(f"job exceeded {timeout_s:.0f}s")

    def respawn(self) -> None:
        try:
            self.process.kill()
            self.process.join(5)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.parent_conn.close()
        except Exception:  # noqa: BLE001
            pass
        self.respawns += 1
        self._start()

    def shutdown(self) -> None:
        try:
            self.parent_conn.send(None)
            self.process.join(2)
        except Exception:  # noqa: BLE001
            pass
        if self.process.is_alive():
            self.process.kill()


class WorkerPool:
    def __init__(self, size: int = 2) -> None:
        self.size = size
        # Boot the workers CONCURRENTLY. Worker() blocks until its child has
        # imported build123d, so a list comprehension made startup linear in
        # pool size — the reason the pool stayed at 2 was that widening it made
        # the first cook wait proportionally longer. The imports happen in child
        # processes and the parent only waits on a pipe, so threads are enough.
        # If one worker fails to boot, the others have already started and must
        # be reaped: the executor waits for every submitted task before the
        # exception surfaces, and `self.workers` would never be assigned, so
        # nothing would hold a reference to shut them down. daemon=True only
        # covers a clean interpreter exit, and each orphan pins ~200MB of OCP.
        with ThreadPoolExecutor(max_workers=size) as boot:
            futures = [boot.submit(Worker) for _ in range(size)]
        started, failure = [], None
        for f in futures:
            try:
                started.append(f.result())
            except Exception as err:  # noqa: BLE001
                failure = failure or err
        if failure is not None:
            for w in started:
                w.shutdown()
            raise failure
        self.workers = started
        self._free: list[Worker] = list(self.workers)
        self._lock = threading.Lock()
        self._available = threading.Semaphore(size)

    def execute(self, job: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        """Thread-safe blocking execute — call from a threadpool, never the
        event loop. A timed-out or crashed worker is respawned before the
        error surfaces, so the pool never shrinks."""
        self._available.acquire()
        with self._lock:
            worker = self._free.pop()
        try:
            return worker.request(job, timeout_s)
        except WorkerTimeout:
            worker.respawn()
            return {"ok": False, "stage": "TIMEOUT",
                    "error": f"execution exceeded {timeout_s:.0f}s and was killed",
                    "hint": "the code likely loops forever or models something explosive — simplify"}
        except WorkerCrash as err:
            worker.respawn()
            return {"ok": False, "stage": "KERNEL_CRASH",
                    "error": f"the geometry kernel crashed running this code ({err})",
                    "hint": "a boolean/fillet crashed OCCT — reduce radii, fillet fewer edges, or reorder features"}
        finally:
            with self._lock:
                self._free.append(worker)
            self._available.release()

    def stats(self) -> dict[str, Any]:
        return {
            "size": self.size,
            "alive": sum(1 for w in self.workers if w.process.is_alive()),
            "respawns": sum(w.respawns for w in self.workers),
        }

    def shutdown(self) -> None:
        for w in self.workers:
            w.shutdown()
