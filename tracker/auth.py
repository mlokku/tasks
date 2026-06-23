"""
WebAuthn passkey authentication + signed-JWT session cookie.

A faithful port of the original Express ``auth.mjs``. Uses ``py_webauthn``
(which is designed to pair with the ``@simplewebauthn/browser`` the UI already
ships) and ``PyJWT``. The single in-flight registration/authentication
challenge is persisted in a one-row table with a 90-second TTL.
"""
from __future__ import annotations

from datetime import timedelta
from functools import wraps
from pathlib import Path
import json
import os
import secrets

import jwt as pyjwt
from django.conf import settings as django_settings
from django.http import JsonResponse
from django.utils import timezone as dj_timezone
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .common import iso_now
from .models import Passkey, PendingChallenge

RP_ID = os.environ.get("WEBAUTHN_RP_ID", "localhost")
RP_ORIGIN = os.environ.get("WEBAUTHN_RP_ORIGIN", "http://localhost:8000")
RP_NAME = os.environ.get("WEBAUTHN_RP_NAME", "Task Tracker")

# Stable opaque handle for the single account (discoverable credentials map to it).
_USER_ID = b"task-tracker-owner"
_COOKIE = "session"
_SESSION_TTL = timedelta(hours=8)
_CHALLENGE_TTL = timedelta(seconds=90)


def _resolve_jwt_secret() -> str:
    env_value = os.environ.get("JWT_SECRET")
    if env_value:
        return env_value
    secret_file = Path(django_settings.BASE_DIR) / "data" / "jwt-secret.local"
    try:
        return secret_file.read_text(encoding="utf-8").strip()
    except OSError:
        generated = secrets.token_hex(32)
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        secret_file.write_text(generated, encoding="utf-8")
        os.chmod(secret_file, 0o600)
        return generated


_SECRET = _resolve_jwt_secret()


# --------------------------------------------------------------------------- #
# JWT session
# --------------------------------------------------------------------------- #

def issue_jwt() -> str:
    now = dj_timezone.now()
    payload = {
        "sub": "owner",
        "iat": int(now.timestamp()),
        "exp": int((now + _SESSION_TTL).timestamp()),
    }
    return pyjwt.encode(payload, _SECRET, algorithm="HS256")


def verify_jwt(token: str) -> dict:
    return pyjwt.decode(token, _SECRET, algorithms=["HS256"])


def is_authenticated(request) -> bool:
    token = request.COOKIES.get(_COOKIE)
    if not token:
        return False
    try:
        verify_jwt(token)
        return True
    except pyjwt.PyJWTError:
        return False


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        _COOKIE,
        token,
        max_age=int(_SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="Strict",
        secure=RP_ORIGIN.startswith("https"),
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(_COOKIE, path="/")


def require_auth(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        token = request.COOKIES.get(_COOKIE)
        if not token:
            return JsonResponse({"error": "Not authenticated."}, status=401)
        try:
            verify_jwt(token)
        except pyjwt.PyJWTError:
            response = JsonResponse({"error": "Session expired."}, status=401)
            clear_session_cookie(response)
            return response
        return view(request, *args, **kwargs)

    return wrapped


# --------------------------------------------------------------------------- #
# Challenge store (single row, 90s TTL)
# --------------------------------------------------------------------------- #

def store_challenge(challenge: bytes) -> None:
    PendingChallenge.objects.update_or_create(
        id=PendingChallenge.SINGLETON_ID,
        defaults={
            "value": bytes_to_base64url(challenge),
            "expires_at": dj_timezone.now() + _CHALLENGE_TTL,
        },
    )


def consume_challenge() -> bytes | None:
    try:
        pending = PendingChallenge.objects.get(id=PendingChallenge.SINGLETON_ID)
    except PendingChallenge.DoesNotExist:
        return None
    value, expires_at = pending.value, pending.expires_at
    pending.delete()
    if dj_timezone.now() > expires_at:
        return None
    return base64url_to_bytes(value)


# --------------------------------------------------------------------------- #
# WebAuthn ceremonies
# --------------------------------------------------------------------------- #

def _parse_transports(raw: str) -> list[AuthenticatorTransport]:
    try:
        values = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    out = []
    for value in values:
        try:
            out.append(AuthenticatorTransport(value))
        except ValueError:
            continue
    return out


def build_registration_options() -> dict:
    exclude = [
        PublicKeyCredentialDescriptor(
            id=base64url_to_bytes(p.id),
            transports=_parse_transports(p.transports),
        )
        for p in Passkey.objects.all()
    ]
    options = generate_registration_options(
        rp_id=RP_ID,
        rp_name=RP_NAME,
        user_name="owner",
        user_id=_USER_ID,
        user_display_name="Owner",
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=exclude,
    )
    store_challenge(options.challenge)
    return json.loads(options_to_json(options))


def complete_registration(credential: dict, passkey_name: str) -> None:
    expected = consume_challenge()
    if expected is None:
        raise ChallengeExpired()
    verification = verify_registration_response(
        credential=json.dumps(credential),
        expected_challenge=expected,
        expected_origin=RP_ORIGIN,
        expected_rp_id=RP_ID,
        require_user_verification=True,
    )
    transports = (credential.get("response") or {}).get("transports") or []
    Passkey.objects.update_or_create(
        id=credential["id"],
        defaults={
            "public_key": bytes_to_base64url(verification.credential_public_key),
            "counter": verification.sign_count,
            "transports": json.dumps(transports),
            "name": passkey_name.strip() if passkey_name and passkey_name.strip() else "Passkey",
            "created_at": iso_now(),
        },
    )


def build_authentication_options() -> dict:
    options = generate_authentication_options(
        rp_id=RP_ID,
        user_verification=UserVerificationRequirement.REQUIRED,
        allow_credentials=[],
    )
    store_challenge(options.challenge)
    return json.loads(options_to_json(options))


def complete_authentication(credential: dict) -> None:
    passkey = Passkey.objects.filter(id=credential.get("id")).first()
    if passkey is None:
        raise UnknownCredential()
    expected = consume_challenge()
    if expected is None:
        raise ChallengeExpired()
    verification = verify_authentication_response(
        credential=json.dumps(credential),
        expected_challenge=expected,
        expected_origin=RP_ORIGIN,
        expected_rp_id=RP_ID,
        credential_public_key=base64url_to_bytes(passkey.public_key),
        credential_current_sign_count=passkey.counter,
        require_user_verification=True,
    )
    passkey.counter = verification.new_sign_count
    passkey.save(update_fields=["counter"])


class ChallengeExpired(Exception):
    """Raised when no valid pending challenge is available."""


class UnknownCredential(Exception):
    """Raised when an authentication attempt references an unknown passkey."""
