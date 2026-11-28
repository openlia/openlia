import asyncio
import os
import sys
from pathlib import Path

# Add docker/ directory to sys.path so openlia_link_rewriter can be imported directly
docker_dir = str(Path(__file__).resolve().parent.parent / "docker")
if docker_dir not in sys.path:
    sys.path.insert(0, docker_dir)

from openlia_link_rewriter import (
    install_gateway_rewriter,
    patch_adapter_methods,
    rewrite_openlia_links,
)


def test_rewrite_workspace_links_with_origin():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test"
    try:
        sample = "[Roadmap](openlia://workspace/goals/roadmap.md)"
        assert (
            rewrite_openlia_links(sample)
            == "[Roadmap](https://workspace.example.test/files/goals/roadmap.md)"
        )

        sample_hash = "[Section](openlia://workspace/goals/plan.md#milestones)"
        assert (
            rewrite_openlia_links(sample_hash)
            == "[Section](https://workspace.example.test/files/goals/plan.md#milestones)"
        )

        sample_encoded = "See openlia://workspace/calendar/2026-09-30%20sync.md."
        assert (
            rewrite_openlia_links(sample_encoded)
            == "See https://workspace.example.test/files/calendar/2026-09-30%20sync.md."
        )

        sample_multi = (
            "Files: openlia://workspace/tasks.md, openlia://workspace/notes.md;"
        )
        assert (
            rewrite_openlia_links(sample_multi)
            == "Files: https://workspace.example.test/files/tasks.md, https://workspace.example.test/files/notes.md;"
        )

        sample_skills = "[Weather Skill](openlia://skills/weather/SKILL.md)"
        assert (
            rewrite_openlia_links(sample_skills)
            == "[Weather Skill](https://workspace.example.test/skills/weather/SKILL.md)"
        )

        sample_single_skill = "See openlia://skill/review/helper.py."
        assert (
            rewrite_openlia_links(sample_single_skill)
            == "See https://workspace.example.test/skills/review/helper.py."
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_preserve_canonical_links_without_origin():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = ""
    try:
        sample = "[Task](openlia://workspace/tasks.md)"
        assert rewrite_openlia_links(sample) == sample
        skill_sample = "[Skill](openlia://skills/weather/SKILL.md)"
        assert rewrite_openlia_links(skill_sample) == skill_sample
        singular_skill_sample = "openlia://skill/weather/SKILL.md"
        assert rewrite_openlia_links(singular_skill_sample) == singular_skill_sample
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_origin_with_trailing_slash():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test/"
    try:
        sample = "[Doc](openlia://workspace/doc.md)"
        assert (
            rewrite_openlia_links(sample)
            == "[Doc](https://workspace.example.test/files/doc.md)"
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_passthrough_non_openlia():
    assert rewrite_openlia_links(None) is None
    assert rewrite_openlia_links(123) == 123
    assert rewrite_openlia_links("") == ""
    assert (
        rewrite_openlia_links("Normal https://google.com link")
        == "Normal https://google.com link"
    )
    assert (
        rewrite_openlia_links("[Web](https://workspace.example.com/files/notes.md)")
        == "[Web](https://workspace.example.com/files/notes.md)"
    )


def test_adapter_patching():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test"
    try:
        sent_messages = []

        class DummyAdapter:
            async def send(self, chat_id: str, content: str, reply_to=None, metadata=None):
                sent_messages.append(("send", chat_id, content))
                return True

            async def edit_message(self, chat_id: str, message_id: str, content: str, finalize=False):
                sent_messages.append(("edit", chat_id, message_id, content))
                return True

            async def send_draft(self, chat_id: str, draft_id: int, content: str, metadata=None):
                sent_messages.append(("draft", chat_id, draft_id, content))
                return True

            async def send_for_platform(self, platform: str, chat_id: str, content: str, metadata=None):
                sent_messages.append(("relay", platform, chat_id, content))
                return True

        patch_adapter_methods(DummyAdapter)
        adapter = DummyAdapter()

        async def run_calls():
            await adapter.send("chat1", "Here is [Plan](openlia://workspace/plan.md)")
            await adapter.edit_message("chat1", "msg1", "Updated [Notes](openlia://workspace/notes/today.md)")
            await adapter.send_draft("chat1", 42, "Draft openlia://workspace/inbox.md.")
            await adapter.send_for_platform("telegram", "chat1", "Relay [Skill](openlia://skills/menu/SKILL.md)")

        asyncio.run(run_calls())

        assert len(sent_messages) == 4
        assert (
            sent_messages[0][2]
            == "Here is [Plan](https://workspace.example.test/files/plan.md)"
        )
        assert (
            sent_messages[1][3]
            == "Updated [Notes](https://workspace.example.test/files/notes/today.md)"
        )
        assert (
            sent_messages[2][3]
            == "Draft https://workspace.example.test/files/inbox.md."
        )
        assert (
            sent_messages[3][3]
            == "Relay [Skill](https://workspace.example.test/skills/menu/SKILL.md)"
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_cron_and_send_message_patching():
    import types

    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test"
    saved_modules = {}
    mod_names = (
        "gateway",
        "gateway.delivery",
        "cron",
        "cron.scheduler_delivery",
        "cron.scheduler",
        "tools",
        "tools.send_message_tool",
    )
    for name in mod_names:
        saved_modules[name] = sys.modules.get(name)
    try:
        recorded = []

        class DummyDeliveryRouter:
            async def deliver(self, content: str, targets=None, **kwargs):
                recorded.append(("router.deliver", content))
                return {"ok": True}

            async def _deliver_to_platform(self, target, content: str, metadata=None):
                recorded.append(("router._deliver_to_platform", target, content))
                return {"ok": True}

        def dummy_deliver_result(job: dict, content: str, *args, **kwargs):
            recorded.append(("cron._deliver_result", job.get("id"), content))
            return None

        async def dummy_send_to_platform(platform, pconfig, chat_id, message, *args, **kwargs):
            recorded.append(("send_message._send_to_platform", platform, chat_id, message))
            return {"success": True}

        gateway_mod = types.ModuleType("gateway")
        delivery_mod = types.ModuleType("gateway.delivery")
        delivery_mod.DeliveryRouter = DummyDeliveryRouter
        gateway_mod.delivery = delivery_mod

        cron_mod = types.ModuleType("cron")
        sched_delivery_mod = types.ModuleType("cron.scheduler_delivery")
        sched_delivery_mod._deliver_result = dummy_deliver_result
        sched_mod = types.ModuleType("cron.scheduler")
        sched_mod._deliver_result = dummy_deliver_result
        cron_mod.scheduler_delivery = sched_delivery_mod
        cron_mod.scheduler = sched_mod

        tools_mod = types.ModuleType("tools")
        send_msg_mod = types.ModuleType("tools.send_message_tool")
        send_msg_mod._send_to_platform = dummy_send_to_platform
        tools_mod.send_message_tool = send_msg_mod

        sys.modules["gateway"] = gateway_mod
        sys.modules["gateway.delivery"] = delivery_mod
        sys.modules["cron"] = cron_mod
        sys.modules["cron.scheduler_delivery"] = sched_delivery_mod
        sys.modules["cron.scheduler"] = sched_mod
        sys.modules["tools"] = tools_mod
        sys.modules["tools.send_message_tool"] = send_msg_mod

        install_gateway_rewriter()

        router = DummyDeliveryRouter()

        async def run_async_checks():
            await router.deliver("Cron [Menu](openlia://workspace/family-menu.md)")
            await router._deliver_to_platform("telegram:123", "Live [Menu](openlia://workspace/family-menu.md)")
            await send_msg_mod._send_to_platform("telegram", {}, "123", "Standalone openlia://workspace/family-menu.md.")

        asyncio.run(run_async_checks())
        sched_mod._deliver_result({"id": "job1"}, "Result: openlia://workspace/family-menu.md")

        assert recorded == [
            ("router.deliver", "Cron [Menu](https://workspace.example.test/files/family-menu.md)"),
            ("router._deliver_to_platform", "telegram:123", "Live [Menu](https://workspace.example.test/files/family-menu.md)"),
            ("send_message._send_to_platform", "telegram", "123", "Standalone https://workspace.example.test/files/family-menu.md."),
            ("cron._deliver_result", "job1", "Result: https://workspace.example.test/files/family-menu.md"),
        ]
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)
        for name, mod in saved_modules.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


if __name__ == "__main__":
    test_rewrite_workspace_links_with_origin()
    test_preserve_canonical_links_without_origin()
    test_origin_with_trailing_slash()
    test_passthrough_non_openlia()
    test_adapter_patching()
    test_cron_and_send_message_patching()
    print("All Python link rewriter tests passed successfully!")
