"""Self-check for the jev-compact context engine.

No network, no real node, no Hermes session: every subprocess call is a stub, and the
built-in compressor is replaced by a spy for the assertions that care whether it ran.
What this pins is the wiring — which path each outcome takes, what the built-in is handed,
and what the ledger records — so a change to the decision logic fails here instead of
silently compacting every session the expensive way.

The sibling ``__init__.py`` is imported by path: the directory name is not an importable
identifier. Loading happens inside ``main()`` rather than at import time because the plugin
loader execs every ``*.py`` in a plugin directory, and a self-check must not fire just
because Hermes loaded the engine.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent

# A transcript shaped like the thing this engine exists for: a few huge tool payloads
# with tiny prose around them. 20 pairs x ~2000 chars of result text each.
_PAIR_COUNT = 20
_PAIR_CHARS = 2000


class _Proc:
    """What the engine sees when it asks a subprocess for a verdict."""

    def __init__(self, out: str = "", rc: int = 0) -> None:
        self.stdout, self.returncode = out, rc


def _transcript(pairs: int = _PAIR_COUNT, chars: int = _PAIR_CHARS) -> list:
    """``pairs`` assistant tool-call + tool-result rows, with a pinned head and tail."""
    bulk = "x" * chars
    messages = [{"role": "user", "content": "find the slow step"}]
    for i in range(pairs):
        messages.append(
            {
                "role": "assistant",
                "content": f"checking {i}",
                "tool_calls": [
                    {
                        "id": f"call-{i}",
                        "function": {"name": "Bash", "arguments": json.dumps({"command": f"step {i} {bulk}"})},
                    }
                ],
            }
        )
        messages.append({"role": "tool", "tool_call_id": f"call-{i}", "content": bulk})
    messages.extend({"role": "user", "content": f"tail {i}"} for i in range(8))
    return messages


def _verdict(messages: list, reason: str = "judged", compacted: bool = True) -> str:
    """A `compact-live` answer: ``{messages, compacted, reason, reducedBy}``."""
    return json.dumps({"messages": messages, "compacted": compacted, "reason": reason, "reducedBy": 4096})


@contextlib.contextmanager
def _spy_super(sentinel: str = "SUPER"):
    """Stand in for ``ContextCompressor.compress`` and record how it was called.

    Patched on the parent class rather than through a seam in the engine, so the engine
    carries no test-only code. A zero-argument ``super().compress()`` inside the engine
    resolves through the MRO at call time and picks this up.
    """
    from agent.context_compressor import ContextCompressor

    calls: list = []
    original = ContextCompressor.compress

    def _fake(self, messages, *args, **kwargs):
        calls.append({"messages": messages, "args": args, "kwargs": kwargs})
        return sentinel

    ContextCompressor.compress = _fake
    try:
        yield calls
    finally:
        ContextCompressor.compress = original


@contextlib.contextmanager
def _env(**overrides: str):
    """Set env vars for the block, restoring whatever was there before."""
    saved = {k: os.environ.get(k) for k in overrides}
    os.environ.update({k: v for k, v in overrides.items() if v is not None})
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> None:
    # The engine is a compression pass, not a logging demo: keep the transcript clean so
    # the last stdout line is the verdict and nothing else.
    logging.disable(logging.CRITICAL)

    spec = importlib.util.spec_from_file_location("jev_compact_plugin", _HERE / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    sys.modules["jev_compact_plugin"] = plugin
    spec.loader.exec_module(plugin)
    engine_cls = plugin.JevCompactCompressor

    def engine(run, threshold: int = 1_000_000):
        """An engine with a pinned budget: no model probe, no lazy threshold resolution."""
        e = engine_cls(model="test-model", quiet_mode=True, run=run)
        e.context_length = 10_000_000  # window share never binds unless a case sets it
        e.threshold_tokens = threshold
        return e

    before = _transcript()
    small = [{"role": "user", "content": "found it"}, {"role": "assistant", "content": "the slow step is step 7"}]
    before_chars = plugin._payload_chars(before)
    assert before_chars > 40_000, before_chars
    assert plugin._payload_chars(small) < 4_000, "small must clear a 1000-token threshold"

    # 1. A Jev result that is genuinely small enough is the answer; the built-in never runs.
    sent = {}

    def ok_run(payload: str) -> _Proc:
        sent["payload"] = json.loads(payload)
        return _Proc(_verdict(small))

    with _spy_super() as calls:
        out = engine(ok_run, threshold=1000).compress(before, current_tokens=99)
    # By value, not identity: the verdict comes back through the subprocess as JSON, so
    # the judge cannot hand us the same objects it was given.
    assert out == small, "compress must return the judge's own messages"
    assert out is not before, "the returned list is the judge's, not the original transcript"
    assert calls == [], "a Jev result under the threshold must not reach the built-in summarizer"
    assert sent["payload"] == {"messages": before}, "the whole transcript must reach the judge on stdin"

    # 2. A judge that fails hands the untouched transcript to the built-in, with every
    #    argument forwarded verbatim — focus_topic and force included.
    with _spy_super() as calls:
        out = engine(lambda _p: _Proc("", 1)).compress(
            before, current_tokens=7, focus_topic="the slow step", force=True,
            memory_context="remember the deploy", bypass_cooldown=True,
        )
    assert out == "SUPER", out
    assert len(calls) == 1, calls
    assert calls[0]["messages"] is before, "a failed judge must not rebuild the message list"
    assert calls[0]["args"] == (), calls[0]["args"]
    assert calls[0]["kwargs"] == {
        "current_tokens": 7,
        "focus_topic": "the slow step",
        "force": True,
        "memory_context": "remember the deploy",
        "bypass_cooldown": True,
    }, calls[0]["kwargs"]

    # 2b. A failed judge below the built-in threshold (the Jev gate sits far under it, and
    #     the free quota runs out daily) must not become an early lossy summary: the
    #     transcript comes back unchanged. The host's own token count, when over the
    #     threshold, still wins over the chars/4 estimate.
    with _spy_super() as calls:
        out = engine(lambda _p: _Proc("", 1)).compress(before)
    assert out is before, "below the built-in threshold a failed judge is a no-op"
    assert calls == [], "the built-in summary must not run early"
    with _spy_super() as calls:
        out = engine(lambda _p: _Proc("", 1)).compress(before, current_tokens=1_000_000)
    assert out == "SUPER" and len(calls) == 1, "the host count says over: the built-in runs"

    # 3. Compacted, but not small enough: the built-in is handed Jev's result, not the
    #    original — the judgment is worth keeping even when it is not worth finishing.
    huge = [{"role": "user", "content": "z" * 20_000}]
    with _spy_super() as calls:
        out = engine(lambda _p: _Proc(_verdict(huge)), threshold=1000).compress(before)
    assert out == "SUPER", out
    assert len(calls) == 1, calls
    assert calls[0]["messages"] == huge, "the built-in must receive the compacted messages"
    assert calls[0]["messages"] is not before, "not the original transcript"

    # 3b. Same, for every other way the judge can let us down: absent node, timeout,
    #     unreadable JSON, a shape we do not understand, and an honest "not compacted".
    def raiser(exc):
        def _run(_payload):
            raise exc
        return _run

    for label, run in (
        ("no-node", raiser(FileNotFoundError("node"))),
        ("timeout", raiser(subprocess.TimeoutExpired("node", 20))),
        ("bad-json", lambda _p: _Proc("not json at all")),
        ("empty-stdout", lambda _p: _Proc("")),
        ("wrong-shape", lambda _p: _Proc(json.dumps({"messages": small, "compacted": "yes"}))),
        ("not-compacted", lambda _p: _Proc(_verdict(small, reason="no key", compacted=False))),
        ("rc-2", lambda _p: _Proc("", 2)),
    ):
        with _spy_super() as calls:
            out = engine(run, threshold=1000).compress(before)
        assert out == "SUPER", f"{label}: {out}"
        assert len(calls) == 1 and calls[0]["messages"] is before, f"{label}: {calls}"

    # 4a. should_compress: the Jev gate, its 10000-token cooldown, and the built-in's
    #     own answer still applying underneath it.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        e = engine(lambda _p: _Proc(_verdict(small)), threshold=1_000_000)
        assert e.should_compress(199_999) is False, "under the Jev gate, and the built-in says no"
        assert e.should_compress(200_000) is True, "the gate is inclusive at 200000"
        assert e.should_compress(205_000) is False, "cooldown: only +5000 tokens since the attempt"
        assert e.should_compress(209_999) is False, "cooldown: still under 10000"
        assert e.should_compress(210_000) is True, "cooldown elapsed at exactly +10000"
        assert e.should_compress(210_500) is False, "the attempt at 60000 re-arms the cooldown"
        assert e.should_compress(220_000) is True

    # 4b. A prompt below the gate must not spend the Jev budget, and the built-in's
    #     trigger still fires on its own.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        e = engine(lambda _p: _Proc(_verdict(small)), threshold=1000)
        assert e.should_compress(2000) is True, "over the built-in threshold, under the Jev gate"
        assert e.should_compress(400) is False, "under the built-in threshold"
        assert e.should_compress(200_000) is True, "the unused Jev budget is still there"

    # 4c. The gate is configurable, and a junk value falls back to the default instead of
    #     taking compression down with it.
    with _env(JEV_COMPACT_AT_TOKENS="200"):
        assert engine(lambda _p: _Proc(_verdict(small)), threshold=1_000_000).should_compress(200) is True
    with _env(JEV_COMPACT_AT_TOKENS="not-a-number"):
        e = engine(lambda _p: _Proc(_verdict(small)), threshold=1_000_000)
        assert e.should_compress(200_000) is True
        assert e.should_compress(199_999) is False

    # 4d. /reset clears the cooldown: a new session's first over-threshold turn is a real
    #     first attempt, not one hidden behind the previous session's anchor.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        e = engine(lambda _p: _Proc(_verdict(small)), threshold=1_000_000)
        assert e.should_compress(200_000) is True
        assert e.should_compress(205_000) is False
        e.on_session_reset()
        assert e.should_compress(205_000) is True

    # 4e. No usable prompt_tokens never raises and never forks a judge.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        e = engine(lambda _p: (_ for _ in ()).throw(AssertionError("must not judge")), threshold=1_000_000)
        assert e.should_compress() is False
        assert e.should_compress(None) is False

    # 4f. A smaller window lowers the gate to 60% of it: 100k window -> 60k gate.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        e = engine(lambda _p: _Proc(_verdict(small)))
        e.context_length = 100_000
        assert e.should_compress(59_999) is False, "under 60% of a 100k window"
        assert e.should_compress(60_000) is True, "60% of the window fires before 200k"

    # 5. The ledger: one line per decision, under $HERMES_HOME/logs, counts and reasons
    #    only. Both decisions land in the same file — an engine that fires and always
    #    falls back must be distinguishable from one that never loaded.
    with tempfile.TemporaryDirectory() as td, _env(HERMES_HOME=td, JEV_COMPACT_LEDGER=None):
        with _spy_super():
            engine(lambda _p: _Proc(_verdict(small)), threshold=1000).compress(before)
            engine(lambda _p: _Proc(_verdict(huge)), threshold=1000).compress(before)
            engine(lambda _p: _Proc("", 1)).compress(before)
        ledger = Path(td) / "logs" / "jev-compact.jsonl"
        assert ledger.is_file(), f"the ledger must land in $HERMES_HOME/logs: {ledger}"
        lines = [line for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
        assert len(lines) == 3, lines
        raw = "\n".join(lines)
        entries = [json.loads(line) for line in lines]

        assert [e["path"] for e in entries] == ["jev", "jev+super", "skip"], entries
        assert entries[0]["before_chars"] == before_chars, entries[0]
        assert entries[0]["after_chars"] == plugin._payload_chars(small), entries[0]
        assert entries[0]["dropped"] == before_chars - plugin._payload_chars(small), entries[0]
        assert entries[0]["reason"] == "judged", entries[0]
        assert entries[1]["after_chars"] == plugin._payload_chars(huge), entries[1]
        assert entries[2]["after_chars"] == before_chars and entries[2]["dropped"] == 0, entries[2]
        assert entries[2]["reason"] == "error:RuntimeError", entries[2]
        for entry in entries:
            assert set(entry) == {"ts", "before_chars", "after_chars", "dropped", "path", "reason"}, entry
            assert isinstance(entry["before_chars"], int) and isinstance(entry["dropped"], int), entry
        # Nothing from the transcript may reach disk: the ledger records sizes, not content.
        for secret in ("find the slow step", "checking 0", "tail 7", "messages", "content", "Bash"):
            assert secret not in raw, f"the ledger must not carry {secret!r}"

    # 5b. A ledger that cannot be written is not a reason to fail a compaction.
    with tempfile.TemporaryDirectory() as td, _env(JEV_COMPACT_LEDGER=str(Path(td) / "logs")):
        with _spy_super() as calls:
            out = engine(lambda _p: _Proc(_verdict(small)), threshold=1000).compress(before)
        assert out == small, "a failed ledger write must not change what compress returns"
        assert calls == []

    # 6. The engine is loadable the way Hermes loads it, and names itself correctly.
    #    `register(ctx)` is the official registration and is what the plugin scan calls, so
    #    it must hand back exactly one engine and must not touch anything on the way:
    #    discovery probes availability by constructing an engine, and a probe that forked
    #    a judge or wrote a ledger line would fire the gate before any session existed.
    with tempfile.TemporaryDirectory() as td, _env(HERMES_HOME=td, JEV_COMPACT_LEDGER=None):
        registered: list = []
        plugin.register(
            type("Ctx", (), {"register_context_engine": lambda _self, e: registered.append(e)})()
        )
        assert len(registered) == 1, registered
        assert registered[0].name == "jev-compact", registered[0].name
        assert isinstance(registered[0], engine_cls), registered[0]
        assert not (Path(td) / "logs" / "jev-compact.jsonl").exists(), "constructing must not log"
    # Without register(), the module still exports the class, which is the other half of
    # the documented contract — a bare construction must still be a usable engine.
    assert engine_cls(model="", quiet_mode=True).name == "jev-compact"

    # 7. A clone is a real engine, not a failed deepcopy: the host falls back to the
    #    built-in compressor when cloning raises, which would silently disable the plugin.
    #    The threshold stays above the tokens used below, so the cooldown — not the
    #    built-in's own trigger — is what answers.
    with _env(JEV_COMPACT_AT_TOKENS=None):
        source = engine(lambda _p: _Proc(_verdict(small)), threshold=300_000)
        assert source.should_compress(200_000) is True
        clone = source.clone_for_agent()
        assert isinstance(clone, engine_cls) and clone.name == "jev-compact"
        assert clone.threshold_tokens == 300_000, clone.threshold_tokens
        assert clone is not source and clone._lock is not source._lock
        # The clone starts with a clean budget: it is a different agent, not a snapshot.
        assert clone.should_compress(200_000) is True
        assert clone.should_compress(205_000) is False
        # ...and the source's own anchor is untouched by the clone's claim.
        assert source.should_compress(200_000) is False

    print("JEV_COMPACT_TESTS_OK")


if __name__ == "__main__":
    main()
