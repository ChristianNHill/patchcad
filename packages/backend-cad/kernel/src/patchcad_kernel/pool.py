"""Warm worker pool. Each worker is a spawned process holding a live
build123d interpreter; the parent stays OCP-free so a native crash can only
take down one worker. Timeouts get SIGKILL, crashes get respawned, and both
come back as structured, repairable errors instead of a dead service.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import re
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
    def __init__(self, message: str, phase: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.phase = phase  # the gate running at the kill; None while still building


def _timeout_line(trace_path: str, code: str) -> str | None:
    """The node line a killed worker was stuck on, from the faulthandler dump
    it wrote just before the deadline. Most recent call first, so the first
    "<node>" frame is the innermost line the model wrote."""
    from .gates import source_context  # OCP-free at module level

    try:
        with open(trace_path, encoding="utf8", errors="replace") as f:
            m = re.search(r'File "<node>", line (\d+)', f.read())
    except OSError:
        return None
    return source_context(code, int(m.group(1))) if m and code else None


def _gate_timeout(phase: dict[str, Any], budget: float | None) -> dict[str, Any]:
    """The part BUILT; a gate measuring it ran out of time. That is the gate's
    stage, not a TIMEOUT: "loops forever" sent the generator to simplify a
    threaded stud whose bore probe alone took 28s. The stage keeps the build
    G0-G2-passed for the backend, and its measurements are lost with the worker."""
    stage, port = phase["phase"], phase.get("port")
    what = f'port "{port}" ' if port else ""
    failure = {"stage": stage,
               "error": f"gate {stage} timed out on this geometry: {what}was still being measured after {budget:g}s",
               "hint": "the part built and executed; the gate measuring it ran out of time, which does not by "
                       "itself mean the code is wrong. Keep the features the contract names; fewer, simpler faces "
                       "(no fillet on every edge, one sweep not many) measure faster"}
    if port:
        failure["port"] = port
    return {"ok": False, **failure, "failures": [failure]}


class Worker:
    def __init__(self, trace_path: str) -> None:
        """`trace_path` is this pool slot's own fixed file. A mkstemp name per
        worker leaked one file per kernel that died by SIGKILL, since nothing
        ran to unlink it; a slot's file is reused by the next kernel instead."""
        self.respawns = 0
        self.trace_path = trace_path
        self._start()

    def _start(self) -> None:
        self.parent_conn, child_conn = SPAWN.Pipe()
        self.process = SPAWN.Process(target=worker_main, args=(child_conn, self.trace_path), daemon=True)
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
            except Exception:  # noqa: BLE001, S110 — reaping is best-effort, the boot error is the one to raise
                pass
            raise

    def request(self, job: dict[str, Any], timeout_s: float, gate_timeout_s: float | None = None) -> dict[str, Any]:
        """Blocking send+recv. Raises WorkerTimeout / WorkerCrash; either way
        the caller must consider this worker dead and call respawn().

        With `gate_timeout_s`, the build has `timeout_s` and the gates their own
        budget from the moment the worker reports the build done: it sends
        {"phase": stage, "port"?} as each gate starts, and the last one names
        what was running if the gates run out of time."""
        # Dump the stack a second before the kill, so a timeout can say where.
        try:
            self.parent_conn.send(job | {"trace_after_s": max(timeout_s - 1, timeout_s * 0.8),
                                         "phases": gate_timeout_s is not None})
        except (BrokenPipeError, OSError) as err:
            raise WorkerCrash(f"worker pipe broken before send: {err}") from None
        deadline = time.monotonic() + timeout_s
        phase = None
        while time.monotonic() < deadline:
            if self.parent_conn.poll(0.1):
                try:
                    reply = self.parent_conn.recv()
                except (EOFError, OSError) as err:
                    raise WorkerCrash(f"worker died mid-job: {err}") from None
                if "phase" not in reply:
                    return reply
                if phase is None and gate_timeout_s is not None:
                    deadline = time.monotonic() + gate_timeout_s
                phase = reply
                continue
            if not self.process.is_alive():
                raise WorkerCrash(f"worker exited with code {self.process.exitcode}")
        raise WorkerTimeout(f"job exceeded {timeout_s if phase is None else gate_timeout_s:.0f}s", phase)

    def respawn(self) -> None:
        # Best-effort teardown of a worker already known dead or hung: a failure
        # here changes nothing, and the respawn below is what matters.
        try:
            self.process.kill()
            self.process.join(5)
        except Exception:  # noqa: BLE001, S110
            pass
        try:
            self.parent_conn.close()
        except Exception:  # noqa: BLE001, S110
            pass
        self.respawns += 1
        self._start()

    def shutdown(self) -> None:
        try:
            self.parent_conn.send(None)
            self.process.join(2)
        except Exception:  # noqa: BLE001, S110 — a dead pipe means a dead worker; the kill below covers both
            pass
        if self.process.is_alive():
            self.process.kill()


class WorkerPool:
    def __init__(self, size: int, trace_dir: str) -> None:
        self.size = size
        os.makedirs(trace_dir, exist_ok=True)
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
            futures = [boot.submit(Worker, os.path.join(trace_dir, f"worker-{i}.txt")) for i in range(size)]
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

    def execute(self, job: dict[str, Any], timeout_s: float, gate_timeout_s: float | None = None) -> dict[str, Any]:
        """Thread-safe blocking execute — call from a threadpool, never the
        event loop. A timed-out or crashed worker is respawned before the
        error surfaces, so the pool never shrinks."""
        self._available.acquire()
        with self._lock:
            worker = self._free.pop()
        try:
            return worker.request(job, timeout_s, gate_timeout_s)
        except WorkerTimeout as err:
            # Read before respawn: the new worker truncates the same trace file.
            where = _timeout_line(worker.trace_path, job.get("code", ""))
            worker.respawn()
            if err.phase is not None:
                return _gate_timeout(err.phase, gate_timeout_s)
            error = f"execution exceeded {timeout_s:.0f}s and was killed"
            if where:
                error += f", still running {where}"
            return {"ok": False, "stage": "TIMEOUT", "error": error,
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
