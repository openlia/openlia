from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Add docker/ to sys.path so openlia_dashboard_auth can be imported
docker_dir = str(Path(__file__).resolve().parent.parent / "docker")
if docker_dir not in sys.path:
    sys.path.insert(0, docker_dir)

from openlia_dashboard_auth import get_allowed_emails, install_auth_filter


class TestDashboardAuthWhitelist(unittest.TestCase):
    def test_get_allowed_emails_from_hermes_env(self):
        env = {"HERMES_DASHBOARD_ALLOWED_EMAILS": " Alice@Example.com , bob@domain.org "}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", None)
            emails = get_allowed_emails()
            self.assertEqual(emails, {"alice@example.com", "bob@domain.org"})

    def test_get_allowed_emails_fallback_to_workspace_env(self):
        env = {"OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS": "charlie@test.io, DAVE@TEST.IO"}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("HERMES_DASHBOARD_ALLOWED_EMAILS", None)
            emails = get_allowed_emails()
            self.assertEqual(emails, {"charlie@test.io", "dave@test.io"})

    def test_get_allowed_emails_empty(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HERMES_DASHBOARD_ALLOWED_EMAILS", None)
            os.environ.pop("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", None)
            self.assertEqual(get_allowed_emails(), set())

    def test_auth_filter_mock_provider(self):
        class MockHTTPException(Exception):
            def __init__(self, status_code: int, detail: str):
                self.status_code = status_code
                self.detail = detail
                super().__init__(f"HTTP {status_code}: {detail}")

        mock_fastapi = SimpleNamespace(HTTPException=MockHTTPException)

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

        with patch.dict(
            sys.modules,
            {
                "fastapi": mock_fastapi,
                "plugins.dashboard_auth.self_hosted": mock_plugin_module,
            },
        ):
            install_auth_filter()
            provider = MockSelfHostedOIDCProvider()

            with patch.dict(os.environ, {}, clear=False):
                # 1. Unset allowlist -> all succeed
                os.environ.pop("HERMES_DASHBOARD_ALLOWED_EMAILS", None)
                os.environ.pop("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS", None)
                provider._test_email = "anyone@anywhere.com"
                sess = provider.complete_login()
                self.assertEqual(sess.email, "anyone@anywhere.com")
                self.assertIsNotNone(provider.verify_session())

                # 2. Configured allowlist -> allowed email succeeds
                os.environ["HERMES_DASHBOARD_ALLOWED_EMAILS"] = "owner@example.com"
                provider._test_email = "owner@example.com"
                sess = provider.complete_login()
                self.assertEqual(sess.email, "owner@example.com")
                self.assertIsNotNone(provider.verify_session())
                self.assertEqual(provider.refresh_session().email, "owner@example.com")

                # 3. Case insensitivity
                provider._test_email = "Owner@Example.COM"
                sess = provider.complete_login()
                self.assertEqual(sess.email, "Owner@Example.COM")

                # 4. Disallowed email -> complete_login raises 403
                provider._test_email = "intruder@example.com"
                with self.assertRaises(MockHTTPException) as exc_info:
                    provider.complete_login()
                self.assertEqual(exc_info.exception.status_code, 403)
                self.assertIn("not authorized", exc_info.exception.detail)

                # 5. Disallowed email -> verify_session returns None (clearing session)
                self.assertIsNone(provider.verify_session())

                # 6. Disallowed email -> refresh_session raises 403
                with self.assertRaises(MockHTTPException) as exc_info:
                    provider.refresh_session()
                self.assertEqual(exc_info.exception.status_code, 403)

                # 7. Unverified or missing email_verified -> _session raises 403
                with self.assertRaises(MockHTTPException) as exc_info:
                    provider._session(
                        "id", "ref", {"email": "owner@example.com", "email_verified": False}
                    )
                self.assertEqual(exc_info.exception.status_code, 403)
                self.assertIn("verified", exc_info.exception.detail)

                with self.assertRaises(MockHTTPException) as exc_info_missing:
                    provider._session("id", "ref", {"email": "owner@example.com"})
                self.assertEqual(exc_info_missing.exception.status_code, 403)
                self.assertIn("verified", exc_info_missing.exception.detail)


if __name__ == "__main__":
    unittest.main()
