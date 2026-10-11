"""jev-compact — one Jev judgment in front of Hermes' lossy compaction.

The built-in ``ContextCompressor`` summarizes the middle of a transcript. That is the
right thing to do when the bulk of those tokens are stale, and the wrong thing to do when
the bulk is a handful of enormous tool payloads (a `npm ls`, a build log) that are still
load-bearing. Jev answers a narrower question than "summarize this": for each tool
call/result pair, is this payload still needed for the current task? The judge drops
only what it says to drop, so user and assistant prose survives verbatim.

The judge is not reimplemented here. It is ``agent-glue/cli.mjs compact-live`` in this
repo — the same one Claude Code's in-process hook and the Codex adapter call, wired to a
live Jev endpoint. A second judge in Python would be a second thing to keep honest, and
privacy is pinned in the CLI (``judgeHeadChars: 0``, empty user request): only tool names
and char counts cross the wire.

Registration follows the official context-engine contract: this module exports
``JevCompactCompressor`` (a ``ContextEngine`` subclass) *and* a ``register(ctx)`` that
calls ``ctx.register_context_engine(...)``, so both the context-engine directory scan and
the general plugin system can load it. The host picks the engine with
``context.engine: "jev-compact"`` and then calls ``update_model()`` with the real model,
so the engine is constructed with no model of its own.

Fail-open, everywhere. No node, no credential, a timeout, a non-zero exit, JSON this
cannot read, a result shape it does not understand — every one of those falls through to
``super().compress()``, which is the same guaranteed shrink the built-in always had. The
ledger is best-effort. ``compress()`` itself never raises: a compaction pass that cannot
reach the judge must still compact.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from agent.context_compressor import ContextCompressor

logger = logging.getLogger(__name__)

# Repo root, resolved through the symlink this plugin is usually installed as, so the
# judge that runs is the one in the checkout rather than a copy that can drift.
_REPO = Path(__file__).resolve().parents[3]
_CLI = _REPO / "agent-glue" / "cli.mjs"

# Prompt size above which a Jev pass is worth a fork of the judge. Below it, tool
# payloads are not what is crowding the window, and the built-in summary is the better
# instrument anyway.
_AT_TOKENS_DEFAULT = 200000

# ...or this share of the context window, whichever comes first, so a smaller-window
# fallback model still gets its Jev pass before the built-in summary.
_AT_WINDOW_SHARE = 0.6

# The host consults should_compress() twice per turn, so without a cooldown every turn
# would fork a judge against a transcript that has barely grown.
_COOLDOWN_TOKENS = 10000

_TIMEOUT_S_DEFAULT = 20.0

# Same divisor as agent.model_metadata.CHARS_PER_TOKEN — the only token estimate this
# engine needs, and the one the ledger reports in.
_CHARS_PER_TOKEN = 4


def _at_tokens() -> int:
    """Prompt size at which a Jev pass is worth attempting (``JEV_COMPACT_AT_TOKENS``)."""
    try:
        raw = os.environ.get("JEV_COMPACT_AT_TOKENS", "").strip()
        return int(float(raw)) if raw else _AT_TOKENS_DEFAULT
    except (TypeError, ValueError):
        return _AT_TOKENS_DEFAULT


def _timeout_s() -> float:
    """Judge subprocess deadline (``JEV_COMPACT_TIMEOUT_S``)."""
    try:
        raw = os.environ.get("JEV_COMPACT_TIMEOUT_S", "").strip()
        seconds = float(raw) if raw else _TIMEOUT_S_DEFAULT
    except (TypeError, ValueError):
        return _TIMEOUT_S_DEFAULT
    return seconds if seconds > 0 else _TIMEOUT_S_DEFAULT


def _ledger_path() -> Optional[Path]:
    override = os.environ.get("JEV_COMPACT_LEDGER")
    if override:
        return Path(override)
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return get_hermes_home() / "logs" / "jev-compact.jsonl"
    except Exception:
        base = os.environ.get("HERMES_HOME", "").strip() or str(Path.home() / ".hermes")
        return Path(base) / "logs" / "jev-compact.jsonl"


def _log(entry: Dict[str, Any]) -> None:
    """One JSONL line per compaction decision. Counts and reasons only — never the
    transcript: a ledger that carried messages would be a second copy of the context
    sitting on disk, and the plugin's whole argument is that this data can be dropped.
    An engine that fires and always falls back to the built-in is otherwise
    indistinguishable from one that never loaded."""
    path = _ledger_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _node() -> Optional[str]:
    return shutil.which("node") or next(
        (p for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node") if os.path.exists(p)), None
    )


def _text_len(value: Any) -> int:
    """Chars of model-visible text in *value*; 0 for anything without text in it."""
    if isinstance(value, str):
        return len(value)
    if isinstance(value, (list, tuple)):
        return sum(_text_len(item) for item in value)
    if isinstance(value, dict):
        return sum(_text_len(v) for k, v in value.items() if k in ("text", "content", "input", "output"))
    return 0


def _payload_chars(messages: Any) -> int:
    """Chars the model would actually read across *messages*.

    Mirrors the judge's own ``textLength`` in agent-glue/src/compact.js (message content
    plus tool-call arguments) so ``before_chars``/``after_chars`` mean the same thing on
    both sides of the subprocess, and so the estimate that decides "did this get small
    enough" is measuring the same payload the judge was asked to shrink.
    """
    if not isinstance(messages, (list, tuple)):
        return 0
    total = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        total += _text_len(message.get("content"))
        calls = message.get("tool_calls")
        if not isinstance(calls, (list, tuple)):
            continue
        for call in calls:
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict):
                total += _text_len(function.get("arguments"))
    return total


def _is_message_sequence(value: Any) -> bool:
    """A non-empty list of ``{"role": str, ...}`` rows — the minimum the host's request
    sanitizers will accept. Anything else is a shape this engine refuses to hand on: a
    malformed transcript is a broken request, and the built-in compressor is right there.
    """
    if not isinstance(value, list) or not value:
        return False
    return all(isinstance(m, dict) and isinstance(m.get("role"), str) for m in value)


class JevCompactCompressor(ContextCompressor):
    """The built-in compressor with a Jev pass in front of it.

    Two decisions, deliberately separate:

    * ``should_compress()`` — is a Jev pass worth attempting? Over
      ``JEV_COMPACT_AT_TOKENS`` and at least ``JEV_COOLDOWN_TOKENS`` since the last
      authorized attempt. Everything else is the built-in's call, unchanged.
    * ``compress()`` — Jev first; the built-in summary only for whatever Jev could not
      reclaim. A Jev result that is genuinely under the threshold is returned as-is, so
      a transcript full of dead build logs never pays for a summary that would throw away
      the parts the task still needs.
    """

    @property
    def name(self) -> str:
        return "jev-compact"

    def __init__(self, model: str = "", *, run: Optional[Callable[[str], Any]] = None, **kwargs: Any) -> None:
        # ``run`` is the subprocess seam the self-check injects; None means the real node.
        self._run = run
        # The cooldown anchor is the only state a compression pass mutates, and passes for
        # different sessions can run concurrently on pool siblings.
        self._lock = threading.Lock()
        self._last_jev_tokens: Optional[int] = None
        super().__init__(model=model, **kwargs)

    # ---- per-agent clone ------------------------------------------------------------------
    # The built-in holds a threading.Lock now and a SQLite session connection once a
    # session starts, so the inherited copy.deepcopy cannot work — and the host falls
    # back to the built-in compressor when a clone raises. Build a fresh engine instead and
    # let the host's update_model() re-derive the budget, as it does for any plugin engine.
    def clone_for_agent(self) -> "JevCompactCompressor":
        clone = JevCompactCompressor(
            model=self.model,
            threshold_percent=self._config_threshold_percent,
            protect_first_n=self.protect_first_n,
            protect_last_n=self.protect_last_n,
            summary_target_ratio=self.summary_target_ratio,
            quiet_mode=self.quiet_mode,
            summary_model_override=self.summary_model,
            base_url=self.base_url,
            api_key=self.api_key,
            config_context_length=self._config_context_length,
            provider=self.provider,
            api_mode=self.api_mode,
            abort_on_summary_failure=self.abort_on_summary_failure,
            max_tokens=self.max_tokens,
            model_thresholds=self.model_thresholds,
            threshold_tokens_cap=self.threshold_tokens_cap,
            proactive_prune_tokens=self.proactive_prune_tokens,
            proactive_prune_min_result_chars=self.proactive_prune_min_result_chars,
            proactive_prune_min_reclaim_tokens=self.proactive_prune_min_reclaim_tokens,
            min_tail_user_messages=self.min_tail_user_messages,
            tail_mode=self.tail_mode,
            custom_providers=self.custom_providers,
            run=self._run,
        )
        clone._aux_context_ceiling = self._aux_context_ceiling
        clone.threshold_tokens = self.threshold_tokens
        return clone

    def on_session_reset(self) -> None:
        """A new session is a new budget: a cooldown carried across /reset would silently
        skip the first Jev pass of a transcript that genuinely needs one."""
        super().on_session_reset()
        with self._lock:
            self._last_jev_tokens = None

    # ---- decision ------------------------------------------------------------------------
    def should_compress(self, prompt_tokens: int = None) -> bool:
        """True when a Jev pass is worth attempting, or whenever the built-in says so.

        Never raises. A gate that cannot be evaluated falls through to the built-in's own
        answer, which is the behaviour the session had before this plugin loaded.
        """
        try:
            tokens = prompt_tokens if prompt_tokens is not None else self.last_prompt_tokens
            tokens = int(tokens or 0)
            if tokens >= self._jev_gate() and self._claim_jev_attempt(tokens):
                return True
        except Exception as exc:
            logger.debug("jev-compact: Jev gate skipped (%s)", exc)
        try:
            return bool(super().should_compress(prompt_tokens))
        except Exception as exc:  # pragma: no cover - the guard of last resort
            logger.debug("jev-compact: built-in gate raised (%s)", exc)
            return False

    def _jev_gate(self) -> int:
        """``JEV_COMPACT_AT_TOKENS`` or 60% of the window, whichever is lower."""
        at = _at_tokens()
        try:
            window = int(getattr(self, "context_length", 0) or 0)
        except (TypeError, ValueError):
            window = 0
        return min(at, int(window * _AT_WINDOW_SHARE)) if window > 0 else at

    def _claim_jev_attempt(self, tokens: int) -> bool:
        """Authorize one Jev attempt at *tokens*; False while the cooldown is still warm.

        Anchored on the decision rather than on a successful judge call: a declined or
        failed Jev must not buy the next turn a free re-fork, and this is the only point
        the host is guaranteed to consult before ``compress()``.
        """
        with self._lock:
            last = self._last_jev_tokens
            if last is not None and tokens - last < _COOLDOWN_TOKENS:
                return False
            self._last_jev_tokens = tokens
            return True

    def compress(
        self, messages: List[Dict[str, Any]], current_tokens: Optional[int] = None,
        focus_topic: Optional[str] = None, force: bool = False, memory_context: str = "",
        bypass_cooldown: bool = False,
    ) -> List[Dict[str, Any]]:
        """Jev first, the built-in summary only for the remainder.

        Every parameter is forwarded verbatim, so ``focus_topic``, ``force`` and
        ``memory_context`` reach the built-in unchanged. The built-in's own exceptions
        (a stale-attempt abort, a summary failure it raises on purpose) are NOT swallowed:
        the host uses them as control flow, and this engine is a pre-pass in front of it,
        not a replacement for it.
        """
        before = _payload_chars(messages)
        compacted, reason = self._jev_pass(messages)
        if compacted is None:
            # The Jev gate fires far below the built-in threshold (200k / 60% vs the built-in 50% of the window).
            # A failed Jev pass there (the free quota runs out daily) must not turn into an
            # early lossy summary: hand the transcript back unchanged. The host reads that as
            # "no progress" (no session rotation) and arms its short structural backoff.
            if not force and self._under_threshold(before) and not self._over_by_tokens(current_tokens):
                self._record(before, before, "skip", reason)
                return messages
            self._record(before, before, "super", reason)
            return super().compress(
                messages, current_tokens=current_tokens, focus_topic=focus_topic, force=force,
                memory_context=memory_context, bypass_cooldown=bypass_cooldown,
            )
        after = _payload_chars(compacted)
        # The host's count carries the system prompt and tool schemas the payload estimate
        # cannot see (~33k chars on coco). Without it a Jev result "under" by chars was still
        # over by the host's count, so the next turn's preflight re-forked the judge and the
        # summary only ran a pass later — every pass a judge call against the free quota.
        if self._under_threshold(after, self._overhead_tokens(before, current_tokens)):
            self._record(before, after, "jev", reason)
            return compacted
        # Jev did shrink the transcript, just not enough on its own: hand its result down
        # rather than throwing the judgment away and starting over from the original.
        self._record(before, after, "jev+super", reason)
        return super().compress(
            compacted, current_tokens=current_tokens, focus_topic=focus_topic, force=force,
            memory_context=memory_context, bypass_cooldown=bypass_cooldown,
        )

    def _under_threshold(self, chars: int, overhead_tokens: int = 0) -> bool:
        """Whether *chars* of transcript, plus *overhead_tokens* of prompt outside it, is
        small enough to skip the summary entirely.

        Fails closed: an unreadable threshold means Jev alone has not proven it can carry
        the window, so the built-in summary still runs. Over-compressing is the one error
        this engine cannot make.
        """
        try:
            return (chars / _CHARS_PER_TOKEN) + overhead_tokens < int(self.threshold_tokens)
        except Exception:
            return False

    @staticmethod
    def _overhead_tokens(before_chars: int, current_tokens: Optional[int]) -> int:
        """Tokens the host counted beyond the message payload (system prompt, tool schemas);
        0 when the host passed no count."""
        try:
            return max(0, int(current_tokens) - before_chars // _CHARS_PER_TOKEN) if current_tokens else 0
        except Exception:
            return 0

    def _over_by_tokens(self, current_tokens: Optional[int]) -> bool:
        """The host's own count, when it passed one, beats the chars/4 estimate: it sees the
        system prompt and tool schemas the message payload does not."""
        try:
            return current_tokens is not None and int(current_tokens) >= int(self.threshold_tokens)
        except Exception:
            return True

    def _jev_pass(self, messages: List[Dict[str, Any]]) -> "tuple[Optional[List[Dict[str, Any]]], str]":
        """``(compacted, reason)``; ``(None, reason)`` whenever the answer is unusable.

        No branch here raises. A declined judgment, an absent judge and a broken judge are
        all the same outcome to the caller: compress the built-in way, and say so in the
        ledger so a session that never once reclaimed anything is visible.
        """
        try:
            verdict = self._judge(messages)
        except Exception as exc:
            return None, f"error:{type(exc).__name__}"
        if not isinstance(verdict, dict):
            return None, "shape"
        # `is not True`, not truthiness: a truthy "yes" means this is not the contract the
        # CLI pins, and an answer this engine cannot vouch for is one it must not ship to
        # the model as a transcript.
        if verdict.get("compacted") is not True:
            return None, str(verdict.get("reason") or "not-compacted")
        compacted = verdict.get("messages")
        if not _is_message_sequence(compacted):
            return None, "shape"
        return compacted, str(verdict.get("reason") or "compacted")

    def _judge(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Ask the shared judge over a subprocess. Raises on anything unusable."""
        payload = json.dumps({"messages": messages}, ensure_ascii=False, default=str)
        proc = (self._run or self._run_node)(payload)
        returncode = getattr(proc, "returncode", 1)
        if returncode != 0:
            raise RuntimeError(f"compact-live exited {returncode}")
        return json.loads(getattr(proc, "stdout", "") or "")

    def _run_node(self, payload: str) -> Any:
        node = _node()
        if not node:
            raise RuntimeError("node not found")
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            [node, str(_CLI), "compact-live"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=_timeout_s(),
            cwd=str(_REPO),
            # Names this plugin in ~/.jevgate/usage.jsonl (`cli:hermes-compact`).
            env={**os.environ, "JEV_USAGE_CALLER": "hermes-compact"},
        )

    def _record(self, before: int, after: int, path: str, reason: str) -> None:
        """Log the decision. ``after_chars`` is the transcript as it leaves the Jev stage:
        what this engine returns on the ``jev`` path, what the built-in is handed on the
        other two. Recorded before delegating, so a built-in pass that raises on purpose
        still leaves the line that explains why it was called."""
        _log(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "before_chars": before,
                "after_chars": after,
                "dropped": max(0, before - after),
                "path": path,
                "reason": reason,
            }
        )


def register(ctx) -> None:
    """Official registration: this engine replaces the built-in compressor.

    The host selects it by name (``context.engine: "jev-compact"``) and calls
    ``update_model()`` with the real model right after, so nothing has to be configured
    here.
    """
    ctx.register_context_engine(JevCompactCompressor())


if __name__ == "__main__":
    print("jev-compact: import this through Hermes (context.engine: jev-compact), not directly")
