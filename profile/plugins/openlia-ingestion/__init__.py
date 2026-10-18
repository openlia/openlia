"""OpenLia durable ingestion plugin."""

from __future__ import annotations

from . import adapters, db, metadata, passwords, publication, queue, server
from .runtime import IngestionRuntime


def register(ctx):
    runtime = IngestionRuntime(ctx)
    runtime.register_tools()
    runtime.start()
    ctx.on_unload(runtime.stop)
