"""Prove jev-prune is live in Hermes: real plugin discovery for the coco profile, then the
real tool_execution middleware chain around a fake `terminal` tool with oversized output.
No LLM turn, but every layer the gateway uses between a tool and the model's context.
"""
import os, sys

os.environ["HERMES_HOME"] = os.path.expanduser("~/.hermes/profiles/coco")
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))

from hermes_cli.plugins import discover_plugins, get_plugin_manager, has_middleware
from hermes_cli.middleware import run_tool_execution_middleware

discover_plugins(force=True)
mgr = get_plugin_manager()
print("loaded plugins:", sorted(getattr(mgr, "loaded_plugins", {}) or getattr(mgr, "_plugins", {})))
print("has tool_execution middleware:", has_middleware("tool_execution"))
print("middleware callbacks:", [getattr(c, "__module__", "?") + "." + getattr(c, "__name__", "?")
                                for c in mgr._middleware.get("tool_execution", [])])

BIG = "\n".join(f"line {i} {'z' * 40}" for i in range(400))
print("tool output chars:", len(BIG))

result = run_tool_execution_middleware(
    "terminal",
    {"command": "seq 1 400"},
    lambda args: BIG,
    request="How many lines did seq print?",
)
print("result chars:", len(result) if isinstance(result, str) else type(result))
print("changed:", result != BIG)
print("result tail:", repr(result[-200:]) if isinstance(result, str) else result)
