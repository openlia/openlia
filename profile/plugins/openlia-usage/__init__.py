"""Local estimated usage monitor; independent of Workspace UI."""
import os


def register(ctx):
    if os.environ.get("OPENLIA_USAGE_DISABLE_COLLECTOR") == "1":
        return
    from openlia_usage import Collector
    collector = Collector()
    collector.start()
    ctx.on_unload(collector.stop)
