import asyncio
import os
import sys
from pathlib import Path

# Add docker/ directory to sys.path so openlia_link_rewriter can be imported directly
docker_dir = str(Path(__file__).resolve().parent.parent / "docker")
if docker_dir not in sys.path:
    sys.path.insert(0, docker_dir)

from openlia_link_rewriter import (
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


def test_preserve_canonical_links_without_origin():
    os.environ["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = ""
    try:
        sample = "[Task](openlia://workspace/tasks.md)"
        assert rewrite_openlia_links(sample) == sample
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
            await adapter.edit_message("chat1", "msg1", "Updated [Notes](openlia://workspace/notes/today.md)")
            await adapter.send_draft("chat1", 42, "Draft openlia://workspace/inbox.md.")

        asyncio.run(run_calls())

        assert len(sent_messages) == 3
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
    finally:
        os.environ.pop("OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN", None)


if __name__ == "__main__":
    test_rewrite_workspace_links_with_origin()
    test_preserve_canonical_links_without_origin()
    test_origin_with_trailing_slash()
    test_passthrough_non_openlia()
    test_adapter_patching()
    print("All Python link rewriter tests passed successfully!")
