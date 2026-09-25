"""jev-prune for Hermes — drop the parts of a long tool result that cannot help the task.

Hermes' ``tool_execution`` middleware is the one place a plugin can wrap the real tool
call and answer with a different result, which is exactly what pruning needs (the
``post_tool_call`` observer hook cannot rewrite anything). The middleware contract is
synchronous, so the judge runs as a blocking subprocess: ``agent-glue/cli.mjs prune`` in
this repo, the SAME judge Claude Code's in-process hook uses. A second judge in Python
would have been a second thing to keep honest.

Fail-open everywhere: no node, no credential, a timeout, a non-zero exit, a result shape
this does not understand -> the original result, unchanged. The ledger is best-effort.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Repo root, resolved through the symlink this plugin is usually installed as, so the
# judge that runs is the one in the checkout rather than a copy that can drift.
_REPO = Path(__file__).resolve().parents[3]
_CLI = _REPO / "agent-glue" / "cli.mjs"

# Which tool results are worth judging, and whose keep/drop criteria to use.
# `Bash`/`Read` name the criteria rows in hooks/jev.js, not Hermes tools.
_TARGETS = {
    "terminal": "Bash",
    "run_terminal_cmd": "Bash",
    "read_file": "Read",
    "grep": "Grep",
    "search_files": "Grep",
}

# Result fields that can carry the long string, in order.
_TEXT_KEYS = ("output", "stdout", "content", "text", "result")

# The pre-gate is the same measurement hooks/jev.js makes (`CONFIG.chunkChars`):
# below this, a result cannot earn its Jev call back, so no Node is even started.
_PRE_GATE_CHARS = 16000

_TIMEOUT_S = float(os.environ.get("JEV_PRUNE_TIMEOUT_S", "20"))


def _ledger_path() -> Optional[Path]:
    override = os.environ.get("JEV_PRUNE_LEDGER")
    if override:
        return Path(override)
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return get_hermes_home() / "logs" / "jev-prune.jsonl"
    except Exception:
        return Path.home() / ".hermes" / "logs" / "jev-prune.jsonl"


def _log(entry: Dict[str, Any]) -> None:
    """One JSONL line per judged-prunable call, keep or drop. A middleware that fires and
    keeps everything is otherwise indistinguishable from one that never loaded."""
    path = _ledger_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _node() -> Optional[str]:
    return shutil.which("node") or next(
        (p for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node") if os.path.exists(p)), None
    )


def _extract(result: Any) -> tuple[Optional[str], Optional[str]]:
    """``(text, key)`` where *key* is the dict field it came from (``None`` for a bare str)."""
    if isinstance(result, str):
        return result, None
    if isinstance(result, dict):
        for key in _TEXT_KEYS:
            value = result.get(key)
            if isinstance(value, str):
                return value, key
    return None, None


def prune_text(tool: str, request: str, text: str, run=None) -> Dict[str, Any]:
    """Call the shared judge. ``run`` is injected in the self-check."""
    payload = json.dumps({"tool": tool, "request": request, "text": text})
    runner = run or (
        lambda p: subprocess.run(  # noqa: S603 - fixed argv, no shell
            [_node(), str(_CLI), "prune"],
            input=p,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            cwd=str(_REPO),
        )
    )
    proc = runner(payload)
    if proc.returncode != 0:
        raise RuntimeError(f"prune exited {proc.returncode}")
    return json.loads(proc.stdout)


def _request_of(kwargs: Dict[str, Any]) -> str:
    """The user's request, or "" — and "" means the judge declines, not that it guesses.

    ``run_tool_execution_middleware`` binds ``user_request`` from the turn the tool call
    belongs to. It is ``user_request`` and not ``request`` because ``_run_execution_chain``
    treats a ``request`` kwarg as the execution PAYLOAD — a middleware chain carrying one
    would dispatch the tool with the request string in place of its arguments.

    "" happens: a subagent thread starts with an empty context, and an older Hermes has no
    binding at all. Both must decline. The tool's own arguments used to stand in here and
    they are not a substitute: judged for relevance against ``cat log``, a 40 KB file the
    task was entirely about came back 99.8% dropped (DEVLOG §22.3).
    """
    value = kwargs.get("user_request")
    return value.strip()[:2000] if isinstance(value, str) and value.strip() else ""


def _prune_result(tool_name: str, ctx: Dict[str, Any], result: Any, run=None) -> Any:
    criteria_tool = _TARGETS.get(tool_name)
    if criteria_tool is None:
        return result
    text, key = _extract(result)
    if not text:
        return result
    # Pre-gate before any subprocess: no request, or output too small to earn a
    # Jev call back, and the result passes through unchanged — Node is never
    # even started (a middleware that saves nothing still costs less when it
    # does not fork).
    request = _request_of(ctx)
    if not request:
        _log({"time": datetime.now(timezone.utc).isoformat(), "tool": tool_name, "reason": "no-request"})
        return result
    if len(text) < _PRE_GATE_CHARS:
        _log(
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "tool": tool_name,
                "reason": "below-threshold",
                "before": len(text),
            }
        )
        return result
    started = time.monotonic()
    try:
        out = prune_text(criteria_tool, request, text, run=run)
    except Exception as exc:
        _log(
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "tool": tool_name,
                "reason": "error",
                "error": str(exc)[:200],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
        return result
    _log(
        {
            "time": datetime.now(timezone.utc).isoformat(),
            "tool": tool_name,
            "reason": out.get("reason"),
            "before": out.get("chars_before"),
            "after": out.get("chars_after"),
            "dropped_lines": out.get("dropped_lines"),
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    )
    if not out.get("judged") or not out.get("dropped_lines"):
        return result
    kept = out.get("text")
    if not isinstance(kept, str):
        return result
    if key is None:
        return kept
    return {**result, key: kept}


def _on_tool_execution(**kwargs: Any) -> Any:
    result = kwargs["next_call"](kwargs.get("args"))
    try:
        return _prune_result(str(kwargs.get("tool_name") or ""), kwargs, result)
    except Exception as exc:  # pragma: no cover - the guard of last resort
        logger.warning("jev-prune passed the result through unchanged: %s", exc)
        return result


def register(ctx) -> None:
    ctx.register_middleware("tool_execution", _on_tool_execution)


def _selfcheck() -> None:
    """Smallest thing that fails if the prune wiring breaks. No network, no Hermes."""

    class _Proc:
        def __init__(self, out: str, rc: int = 0) -> None:
            self.stdout, self.returncode = out, rc

    big = "x" * (max(_PRE_GATE_CHARS, 5000) + 100)
    small = "x" * 5000
    dropped = json.dumps(
        {"text": "[jev-prune: dropped 1 lines]", "dropped_lines": 1, "chars_before": len(big),
         "chars_after": 27, "judged": True, "reason": "judged"}
    )

    # the pre-gate: no request or too-small output passes through and never even
    # starts a subprocess (the `run` lambda raising proves it was not called)
    assert _prune_result("terminal", {}, big, run=lambda _p: (_ for _ in ()).throw(AssertionError())) is big
    assert _prune_result("terminal", {"user_request": "r"}, small, run=lambda _p: (_ for _ in ()).throw(AssertionError())) is small
    # a bare-string terminal result is replaced by the pruned text
    assert _prune_result("terminal", {"user_request": "r"}, big, run=lambda _p: _Proc(dropped)) == (
        "[jev-prune: dropped 1 lines]"
    )
    # a dict result keeps its shape, only the text field changes
    out = _prune_result("terminal", {"user_request": "r"}, {"output": big, "exit_code": 0}, run=lambda _p: _Proc(dropped))
    assert out == {"output": "[jev-prune: dropped 1 lines]", "exit_code": 0}, out
    # an unknown tool, an unknown shape and a failing judge all pass through
    assert _prune_result("write_file", {"user_request": "r"}, big, run=lambda _p: _Proc(dropped)) == big
    assert _prune_result("terminal", {"user_request": "r"}, {"rows": [1]}, run=lambda _p: _Proc(dropped)) == {"rows": [1]}
    assert _prune_result("terminal", {"user_request": "r"}, big, run=lambda _p: _Proc("", 1)) == big
    # nothing dropped -> the original object, not a rebuilt copy
    kept = json.dumps({"text": big, "dropped_lines": 0, "judged": True, "reason": "judged"})
    assert _prune_result("terminal", {"user_request": "r"}, big, run=lambda _p: _Proc(kept)) is big
    # the request comes from the middleware context, never from the tool arguments
    assert _request_of({"user_request": "why is the worker slow?"}) == "why is the worker slow?"
    assert _request_of({"args": {"command": "ls -la"}}) == ""
    # `request` is the execution payload key, not the user's request: reading it would
    # both miss the real binding and couple this plugin to a kwarg that breaks dispatch
    assert _request_of({"request": {"command": "ls -la"}}) == ""

    # the middleware calls next_call exactly once and gets the real result back,
    # whatever the prune decides (post-processing failure must not re-dispatch)
    made = []
    out = _on_tool_execution(
        tool_name="terminal",
        user_request="r",
        args={"command": "ls"},
        next_call=lambda args: made.append(args) or "z" * (max(_PRE_GATE_CHARS, 16000) + 100),
    )
    assert len(made) == 1, "next_call must fire exactly once"
    assert isinstance(out, str)

    # the ledger never carries request/result/credentials — only counts and reasons
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        old = os.environ.get("JEV_PRUNE_LEDGER")
        os.environ["JEV_PRUNE_LEDGER"] = str(Path(td) / "logs" / "jev-prune.jsonl")
        try:
            _prune_result("terminal", {"user_request": "r"}, big, run=lambda _p: _Proc(dropped))
        finally:
            if old is None:
                os.environ.pop("JEV_PRUNE_LEDGER", None)
            else:
                os.environ["JEV_PRUNE_LEDGER"] = old
        entries = [json.loads(l) for l in (Path(td) / "logs" / "jev-prune.jsonl").read_text(encoding="utf-8").splitlines()]
        assert entries, "a judged call must leave a ledger line"
        for e in entries:
            assert "request" not in e and "result" not in e and "key" not in e, e
    print("jev-prune selfcheck OK")


if __name__ == "__main__":
    _selfcheck()
