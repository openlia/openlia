"""
OpenLia Outbound Link Rewriter
Rewrites canonical `openlia://workspace/...` URIs in outbound chat messages
and API responses only when OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN is configured.
"""

import functools
import os
import re


def rewrite_openlia_links(text: str) -> str:
    """Rewrite canonical workspace and skills URIs when a public Workspace UI origin exists."""
    if not text or not isinstance(text, str):
        return text
    if "openlia://" not in text:
        return text

    origin = os.environ.get("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if not origin:
        return text

    def repl_workspace(match: re.Match) -> str:
        raw_path = match.group(1).lstrip("/")
        trailing = ""
        while raw_path and raw_path[-1] in ".,;:?!":
            trailing = raw_path[-1] + trailing
            raw_path = raw_path[:-1]
        replaced = f"{origin}/files/{raw_path}"
        return replaced + trailing

    def repl_skills(match: re.Match) -> str:
        raw_path = match.group(1).lstrip("/")
        trailing = ""
        while raw_path and raw_path[-1] in ".,;:?!":
            trailing = raw_path[-1] + trailing
            raw_path = raw_path[:-1]
        replaced = f"{origin}/skills/{raw_path}"
        return replaced + trailing

    text = re.sub(r"openlia://workspace/([^\s\)\]\"'`>]+)", repl_workspace, text)
    text = re.sub(r"openlia://skills?/([^\s\)\]\"'`>]+)", repl_skills, text)
    return text


def patch_adapter_methods(adapter_cls: type) -> None:
    """Patch send, send_for_platform, edit_message, and send_draft on an adapter class to rewrite links in content."""
    if hasattr(adapter_cls, "send") and not getattr(adapter_cls.send, "_openlia_patched", False):
        orig_send = adapter_cls.send

        @functools.wraps(orig_send)
        async def patched_send(self, chat_id: str, content: str, *args, **kwargs):
            if isinstance(content, str):
                content = rewrite_openlia_links(content)
            return await orig_send(self, chat_id, content, *args, **kwargs)

        patched_send._openlia_patched = True
        adapter_cls.send = patched_send

    if hasattr(adapter_cls, "send_for_platform") and not getattr(
        adapter_cls.send_for_platform, "_openlia_patched", False
    ):
        orig_send_for_platform = adapter_cls.send_for_platform

        @functools.wraps(orig_send_for_platform)
        async def patched_send_for_platform(self, platform, chat_id: str, content: str, *args, **kwargs):
            if isinstance(content, str):
                content = rewrite_openlia_links(content)
            return await orig_send_for_platform(self, platform, chat_id, content, *args, **kwargs)

        patched_send_for_platform._openlia_patched = True
        adapter_cls.send_for_platform = patched_send_for_platform

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
    """Install transparent rewriting hooks into Hermes gateway, cron, and send_message components."""
    # 1. BasePlatformAdapter and all its subclasses
    try:
        from gateway.platforms.base import BasePlatformAdapter

        patch_adapter_methods(BasePlatformAdapter)

        orig_init_subclass = BasePlatformAdapter.__init_subclass__

        @classmethod
        def patched_init_subclass(cls, **kwargs):
            orig_init_subclass(**kwargs)
            patch_adapter_methods(cls)

        BasePlatformAdapter.__init_subclass__ = patched_init_subclass

        for sub_cls in BasePlatformAdapter.__subclasses__():
            patch_adapter_methods(sub_cls)
    except Exception:
        pass

    # 2. Patch DeliveryRouter (both deliver and _deliver_to_platform used by cron live delivery)
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

        if hasattr(DeliveryRouter, "_deliver_to_platform") and not getattr(
            DeliveryRouter._deliver_to_platform, "_openlia_patched", False
        ):
            orig_deliver_to_platform = DeliveryRouter._deliver_to_platform

            @functools.wraps(orig_deliver_to_platform)
            async def patched_deliver_to_platform(self, target, content: str, *args, **kwargs):
                if isinstance(content, str):
                    content = rewrite_openlia_links(content)
                return await orig_deliver_to_platform(self, target, content, *args, **kwargs)

            patched_deliver_to_platform._openlia_patched = True
            DeliveryRouter._deliver_to_platform = patched_deliver_to_platform
    except Exception:
        pass

    # 3. Patch cron.scheduler_delivery._deliver_result for cron job delivery (live, standalone, and queued)
    try:
        from cron import scheduler_delivery

        if hasattr(scheduler_delivery, "_deliver_result") and not getattr(
            scheduler_delivery._deliver_result, "_openlia_patched", False
        ):
            orig_cron_deliver = scheduler_delivery._deliver_result

            @functools.wraps(orig_cron_deliver)
            def patched_cron_deliver(job: dict, content: str, *args, **kwargs):
                if isinstance(content, str):
                    content = rewrite_openlia_links(content)
                return orig_cron_deliver(job, content, *args, **kwargs)

            patched_cron_deliver._openlia_patched = True
            scheduler_delivery._deliver_result = patched_cron_deliver

            import sys

            if "cron.scheduler" in sys.modules:
                sched_mod = sys.modules["cron.scheduler"]
                if hasattr(sched_mod, "_deliver_result"):
                    sched_mod._deliver_result = patched_cron_deliver
    except Exception:
        pass

    # 4. Patch tools.send_message_tool._send_to_platform for standalone cron and send_message tool
    try:
        from tools import send_message_tool

        if hasattr(send_message_tool, "_send_to_platform") and not getattr(
            send_message_tool._send_to_platform, "_openlia_patched", False
        ):
            orig_send_to_platform = send_message_tool._send_to_platform

            @functools.wraps(orig_send_to_platform)
            async def patched_send_to_platform(platform, pconfig, chat_id, message, *args, **kwargs):
                if isinstance(message, str):
                    message = rewrite_openlia_links(message)
                return await orig_send_to_platform(platform, pconfig, chat_id, message, *args, **kwargs)

            patched_send_to_platform._openlia_patched = True
            send_message_tool._send_to_platform = patched_send_to_platform
    except Exception:
        pass

    # 5. Patch api_server._resolve_media_to_data_urls for OpenAI API server responses
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
