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
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_rewrite_skills_links_with_origin():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test"
    try:
        sample = "[Triage](openlia://skills/inbox-triage)"
        assert (
            rewrite_openlia_links(sample)
            == "[Triage](https://workspace.example.test/skills/inbox-triage)"
        )

        sample_file = "[Review](openlia://skills/weekly-review/templates/review.md)"
        assert (
            rewrite_openlia_links(sample_file)
            == "[Review](https://workspace.example.test/skills/weekly-review/templates/review.md)"
        )

        sample_trailing = "Check openlia://skills/inbox-triage!"
        assert (
            rewrite_openlia_links(sample_trailing)
            == "Check https://workspace.example.test/skills/inbox-triage!"
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_rewrite_without_origin():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = ""
    try:
        sample = "[Task](openlia://workspace/tasks.md) and [Skill](openlia://skills/daily-briefing)"
        assert (
            rewrite_openlia_links(sample)
            == "[Task](/files/tasks.md) and [Skill](/skills/daily-briefing)"
        )
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

        patch_adapter_methods(DummyAdapter)
        adapter = DummyAdapter()

        async def run_calls():
            await adapter.send("chat1", "Here is [Plan](openlia://workspace/plan.md)")
            await adapter.edit_message("chat1", "msg1", "Updated [Skill](openlia://skills/triage)")
            await adapter.send_draft("chat1", 42, "Draft openlia://workspace/inbox.md.")

        asyncio.run(run_calls())

        assert len(sent_messages) == 3
        assert (
            sent_messages[0][2]
            == "Here is [Plan](https://workspace.example.test/files/plan.md)"
        )
        assert (
            sent_messages[1][3]
            == "Updated [Skill](https://workspace.example.test/skills/triage)"
        )
        assert (
            sent_messages[2][3]
            == "Draft https://workspace.example.test/files/inbox.md."
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


def test_rewrite_source_links():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = "https://workspace.example.test"
    try:
        sample = "[Invoice](openlia://source/src_12345)"
        assert (
            rewrite_openlia_links(sample)
            == "[Invoice](https://workspace.example.test/ingestion/src_12345)"
        )

        sample_page = "[Invoice, p. 2](openlia://source/src_12345#ver_001/p2)"
        assert (
            rewrite_openlia_links(sample_page)
            == "[Invoice, p. 2](https://workspace.example.test/ingestion/src_12345#ver_001/p2)"
        )

        sample_sources = "[Sources](openlia://sources/src_67890)"
        assert (
            rewrite_openlia_links(sample_sources)
            == "[Sources](https://workspace.example.test/ingestion/src_67890)"
        )

        # Without origin
        os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = ""
        assert (
            rewrite_openlia_links(sample)
            == "[Invoice](/ingestion/src_12345)"
        )
        assert (
            rewrite_openlia_links("[Gym](openlia://minions/gym-tracker)")
            == "[Gym](/minions/gym-tracker)"
        )
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


if __name__ == "__main__":
    test_rewrite_workspace_links_with_origin()
    test_rewrite_skills_links_with_origin()
    test_rewrite_source_links()
    test_rewrite_without_origin()
    test_origin_with_trailing_slash()
    test_passthrough_non_openlia()
    test_adapter_patching()
    print("All Python link rewriter tests passed successfully!")
