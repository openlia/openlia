"""
OpenLia Outbound Link Rewriter
Transparently rewrites canonical `openlia://` URIs in outbound chat messages and API responses
to web URLs using OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN (or root-relative /files/... and /skills/...).
"""

import functools
import os
import re
from typing import Any, Dict, Optional


def rewrite_openlia_links(text: str) -> str:
    """Rewrite openlia://workspace/... and openlia://skills/... to accessible HTTP web links or paths."""
    if not text or not isinstance(text, str):
        return text
    if "openlia://" not in text:
        return text

    origin = os.environ.get("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", "").rstrip("/")

    def repl_workspace(match: re.Match) -> str:
        raw_path = match.group(1).lstrip("/")
        trailing = ""
        while raw_path and raw_path[-1] in ".,;:?!":
            trailing = raw_path[-1] + trailing
            raw_path = raw_path[:-1]
        replaced = f"{origin}/files/{raw_path}" if origin else f"/files/{raw_path}"
        return replaced + trailing

    def repl_skills(match: re.Match) -> str:
        raw_path = match.group(1).lstrip("/")
        trailing = ""
        while raw_path and raw_path[-1] in ".,;:?!":
            trailing = raw_path[-1] + trailing
            raw_path = raw_path[:-1]
        replaced = f"{origin}/skills/{raw_path}" if origin else f"/skills/{raw_path}"
        return replaced + trailing

    def repl_source(match: re.Match) -> str:
        raw_path = match.group(1).lstrip("/")
        trailing = ""
        while raw_path and raw_path[-1] in ".,;:?!":
            trailing = raw_path[-1] + trailing
            raw_path = raw_path[:-1]
        replaced = f"{origin}/ingestion/{raw_path}" if origin else f"/ingestion/{raw_path}"
        return replaced + trailing

    text = re.sub(r"openlia://workspace/([^\s\)\]\"'`>]+)", repl_workspace, text)
    text = re.sub(r"openlia://skills/([^\s\)\]\"'`>]+)", repl_skills, text)
    text = re.sub(r"openlia://sources?/([^\s\)\]\"'`>]+)", repl_source, text)
    return text


def patch_adapter_methods(adapter_cls: type) -> None:
    """Patch send, edit_message, and send_draft on an adapter class to rewrite links in content."""
    if hasattr(adapter_cls, "send") and not getattr(adapter_cls.send, "_openlia_patched", False):
        orig_send = adapter_cls.send

        @functools.wraps(orig_send)
        async def patched_send(self, chat_id: str, content: str, *args, **kwargs):
            if isinstance(content, str):
                content = rewrite_openlia_links(content)
            return await orig_send(self, chat_id, content, *args, **kwargs)

        patched_send._openlia_patched = True
        adapter_cls.send = patched_send

    if hasattr(adapter_cls, "edit_message") and not getattr(adapter_cls.edit_message, "_openlia_patched", False):
        orig_edit = adapter_cls.edit_message

        @functools.wraps(orig_edit)
        async def patched_edit(self, chat_id: str, message_id: str, content: str, *args, **kwargs):
            if isinstance(content, str):
                content = rewrite_openlia_links(content)
            return await orig_edit(self, chat_id, message_id, content, *args, **kwargs)

        patched_edit._openlia_patched = True
        adapter_cls.edit_message = patched_edit

    if hasattr(adapter_cls, "send_draft") and not getattr(adapter_cls.send_draft, "_openlia_patched", False):
        orig_draft = adapter_cls.send_draft

        @functools.wraps(orig_draft)
        async def patched_draft(self, chat_id: str, draft_id: int, content: str, *args, **kwargs):
            if isinstance(content, str):
                content = rewrite_openlia_links(content)
            return await orig_draft(self, chat_id, draft_id, content, *args, **kwargs)

        patched_draft._openlia_patched = True
        adapter_cls.send_draft = patched_draft


def install_gateway_rewriter() -> None:
    """Install transparent rewriting hooks into Hermes gateway components."""
    # 1. BasePlatformAdapter and all its subclasses
    try:
        from gateway.platforms.base import BasePlatformAdapter

        # Patch BasePlatformAdapter methods
        patch_adapter_methods(BasePlatformAdapter)

        # Hook __init_subclass__ to auto-patch all subclasses defined later (e.g. plugins)
        orig_init_subclass = BasePlatformAdapter.__init_subclass__

        @classmethod
        def patched_init_subclass(cls, **kwargs):
            orig_init_subclass(**kwargs)
            patch_adapter_methods(cls)

        BasePlatformAdapter.__init_subclass__ = patched_init_subclass

        # Patch any subclasses already created
        for sub_cls in BasePlatformAdapter.__subclasses__():
            patch_adapter_methods(sub_cls)
    except Exception:
        # In non-gateway contexts, BasePlatformAdapter might not be present
        pass

    # 2. Patch DeliveryRouter for cron and background job delivery
    try:
        from gateway.delivery import DeliveryRouter

        if hasattr(DeliveryRouter, "deliver") and not getattr(DeliveryRouter.deliver, "_openlia_patched", False):
            orig_deliver = DeliveryRouter.deliver

            @functools.wraps(orig_deliver)
            async def patched_deliver(self, content: str, *args, **kwargs):
                if isinstance(content, str):
                    content = rewrite_openlia_links(content)
                return await orig_deliver(self, content, *args, **kwargs)

            patched_deliver._openlia_patched = True
            DeliveryRouter.deliver = patched_deliver
    except Exception:
        pass

    # 3. Patch api_server._resolve_media_to_data_urls for OpenAI API server responses
    try:
        from gateway.platforms import api_server

        if hasattr(api_server, "_resolve_media_to_data_urls") and not getattr(
            api_server._resolve_media_to_data_urls, "_openlia_patched", False
        ):
            orig_media = api_server._resolve_media_to_data_urls

            @functools.wraps(orig_media)
            def patched_media(text: str, *args, **kwargs) -> str:
                res = orig_media(text, *args, **kwargs)
                return rewrite_openlia_links(res)

            patched_media._openlia_patched = True
            api_server._resolve_media_to_data_urls = patched_media

            import sys
            if "gateway.platforms.api_server_openai_routes" in sys.modules:
                routes_mod = sys.modules["gateway.platforms.api_server_openai_routes"]
                if hasattr(routes_mod, "_resolve_media_to_data_urls"):
                    routes_mod._resolve_media_to_data_urls = patched_media
    except Exception:
        pass
