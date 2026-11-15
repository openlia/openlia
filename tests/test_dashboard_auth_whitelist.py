from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest

# Add docker/ to sys.path so openlia_dashboard_auth can be imported
docker_dir = str(Path(__file__).resolve().parent.parent / "docker")
if docker_dir not in sys.path:
    sys.path.insert(0, docker_dir)

from openlia_dashboard_auth import get_allowed_emails, install_auth_filter


def test_get_allowed_emails_from_hermes_env(monkeypatch):
    monkeypatch.setenv(
        "HERMES_DASHBOARD_ALLOWED_EMAILS", " Alice@Example.com , bob@domain.org "
    )
    monkeypatch.delenv("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", raising=False)
    emails = get_allowed_emails()
    assert emails == {"alice@example.com", "bob@domain.org"}


def test_get_allowed_emails_fallback_to_workspace_env(monkeypatch):
    monkeypatch.delenv("HERMES_DASHBOARD_ALLOWED_EMAILS", raising=False)
    monkeypatch.setenv(
        "OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", "charlie@test.io, DAVE@TEST.IO"
    )
    emails = get_allowed_emails()
    assert emails == {"charlie@test.io", "dave@test.io"}


def test_get_allowed_emails_empty(monkeypatch):
    monkeypatch.delenv("HERMES_DASHBOARD_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", raising=False)
    assert get_allowed_emails() == set()


def test_auth_filter_mock_provider(monkeypatch):
    # Create mock SelfHostedOIDCProvider class and mock fastapi.HTTPException
    class MockHTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            self.status_code = status_code
            self.detail = detail
            super().__init__(f"HTTP {status_code}: {detail}")

    mock_fastapi = SimpleNamespace(HTTPException=MockHTTPException)
    monkeypatch.setitem(sys.modules, "fastapi", mock_fastapi)

    class MockSession:
        def __init__(self, email: str):
            self.email = email

    class MockSelfHostedOIDCProvider:
        def _session(self, id_token: str, refresh_token: str, claims: dict):
            return MockSession(claims.get("email", ""))

        def complete_login(self, *args, **kwargs):
            return MockSession(getattr(self, "_test_email", "test@example.com"))

        def verify_session(self, *args, **kwargs):
            return MockSession(getattr(self, "_test_email", "test@example.com"))

        def refresh_session(self, *args, **kwargs):
            return MockSession(getattr(self, "_test_email", "test@example.com"))

    mock_plugin_module = SimpleNamespace(
        SelfHostedOIDCProvider=MockSelfHostedOIDCProvider
    )
    monkeypatch.setitem(
        sys.modules, "plugins.dashboard_auth.self_hosted", mock_plugin_module
    )

    install_auth_filter()

    provider = MockSelfHostedOIDCProvider()

    # 1. Unset allowlist -> all succeed
    monkeypatch.delenv("HERMES_DASHBOARD_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", raising=False)
    provider._test_email = "anyone@anywhere.com"
    sess = provider.complete_login()
    assert sess.email == "anyone@anywhere.com"
    assert provider.verify_session() is not None

    # 2. Configured allowlist -> allowed email succeeds
    monkeypatch.setenv("HERMES_DASHBOARD_ALLOWED_EMAILS", "owner@example.com")
    provider._test_email = "owner@example.com"
    sess = provider.complete_login()
    assert sess.email == "owner@example.com"
    assert provider.verify_session() is not None
    assert provider.refresh_session().email == "owner@example.com"

    # 3. Case insensitivity
    provider._test_email = "Owner@Example.COM"
    sess = provider.complete_login()
    assert sess.email == "Owner@Example.COM"

    # 4. Disallowed email -> complete_login raises 403
    provider._test_email = "intruder@example.com"
    with pytest.raises(MockHTTPException) as exc_info:
        provider.complete_login()
    assert exc_info.value.status_code == 403
    assert "not authorized" in exc_info.value.detail

    # 5. Disallowed email -> verify_session returns None (clearing session)
    assert provider.verify_session() is None

    # 6. Disallowed email -> refresh_session raises 403
    with pytest.raises(MockHTTPException) as exc_info:
        provider.refresh_session()
    assert exc_info.value.status_code == 403

    # 7. Unverified email -> _session raises 403
    with pytest.raises(MockHTTPException) as exc_info:
        provider._session(
            "id", "ref", {"email": "owner@example.com", "email_verified": False}
        )
    assert exc_info.value.status_code == 403
    assert "verified" in exc_info.value.detail
