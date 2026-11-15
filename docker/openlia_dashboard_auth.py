"""
OpenLia Dashboard Auth Filter
Enforces an email whitelist on Hermes Dashboard self-hosted OIDC logins
when HERMES_DASHBOARD_ALLOWED_EMAILS or OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS is configured.
"""

from __future__ import annotations

import functools
import logging
import os
from typing import Optional, Set

logger = logging.getLogger(__name__)


def get_allowed_emails() -> Set[str]:
    """Return lowercase normalized allowed email addresses, or empty set if unconfigured."""
    raw = (
        os.environ.get("HERMES_DASHBOARD_ALLOWED_EMAILS")
        or os.environ.get("OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS")
        or ""
    ).strip()
    if not raw:
        return set()
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def install_auth_filter() -> None:
    """Patch SelfHostedOIDCProvider to enforce email allowlist when configured."""
    try:
        from plugins.dashboard_auth.self_hosted import SelfHostedOIDCProvider
    except ImportError:
        # Not running in an environment with dashboard auth plugins
        return

    from fastapi import HTTPException

    orig_complete_login = SelfHostedOIDCProvider.complete_login
    orig_verify_session = SelfHostedOIDCProvider.verify_session
    orig_refresh_session = SelfHostedOIDCProvider.refresh_session
    orig_session = SelfHostedOIDCProvider._session

    if getattr(orig_complete_login, "_openlia_whitelist_patched", False):
        return

    @functools.wraps(orig_session)
    def patched_session(self, id_token: str, refresh_token: str, claims: dict):
        allowed = get_allowed_emails()
        if allowed:
            if claims.get("email_verified") is False:
                logger.warning(
                    "dashboard-auth-whitelist: rejected session for unverified email %r",
                    claims.get("email"),
                )
                raise HTTPException(
                    status_code=403,
                    detail="Forbidden: Your email address must be verified by the OIDC provider",
                )
        return orig_session(self, id_token, refresh_token, claims)

    @functools.wraps(orig_complete_login)
    def patched_complete_login(self, *args, **kwargs):
        session = orig_complete_login(self, *args, **kwargs)
        allowed = get_allowed_emails()
        if allowed:
            email = (getattr(session, "email", "") or "").strip().lower()
            if not email or email not in allowed:
                logger.warning(
                    "dashboard-auth-whitelist: rejected login for unauthorized email %r",
                    email,
                )
                raise HTTPException(
                    status_code=403,
                    detail="Forbidden: Your account is not authorized to access this dashboard",
                )
        return session

    @functools.wraps(orig_verify_session)
    def patched_verify_session(self, *args, **kwargs):
        try:
            session = orig_verify_session(self, *args, **kwargs)
        except HTTPException:
            return None
        if session is None:
            return None
        allowed = get_allowed_emails()
        if allowed:
            email = (getattr(session, "email", "") or "").strip().lower()
            if not email or email not in allowed:
                logger.warning(
                    "dashboard-auth-whitelist: revoked active session for email %r",
                    email,
                )
                return None
        return session

    @functools.wraps(orig_refresh_session)
    def patched_refresh_session(self, *args, **kwargs):
        session = orig_refresh_session(self, *args, **kwargs)
        allowed = get_allowed_emails()
        if allowed:
            email = (getattr(session, "email", "") or "").strip().lower()
            if not email or email not in allowed:
                logger.warning(
                    "dashboard-auth-whitelist: rejected token refresh for email %r",
                    email,
                )
                raise HTTPException(
                    status_code=403,
                    detail="Forbidden: Your account is not authorized to access this dashboard",
                )
        return session

    patched_complete_login._openlia_whitelist_patched = True
    SelfHostedOIDCProvider._session = patched_session
    SelfHostedOIDCProvider.complete_login = patched_complete_login
    SelfHostedOIDCProvider.verify_session = patched_verify_session
    SelfHostedOIDCProvider.refresh_session = patched_refresh_session
