"""Small shared helpers ported from the original JS server/frontend."""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import secrets
import time

# Navigation/identity colours used when auto-assigning a colour to a new
# project. Mirrors the set the original server seeded with.
IDENTITY_COLORS = [
    "#00C2A8",
    "#F97316",
    "#38BDF8",
    "#E11D48",
    "#8B5CF6",
    "#22C55E",
    "#F59E0B",
    "#EC4899",
]

_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _to_base36(n: int) -> str:
    if n <= 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(_BASE36[r])
    return "".join(reversed(out))


def uid(prefix: str) -> str:
    """Mirror the frontend's ``uid()``: ``prefix-<base36 ms>-<6 rand chars>``."""
    millis = int(time.time() * 1000)
    rand = "".join(secrets.choice(_BASE36) for _ in range(6))
    return f"{prefix}-{_to_base36(millis)}-{rand}"


def iso_now() -> str:
    """ISO-8601 UTC timestamp matching JavaScript's ``Date.toISOString()``."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def zoned_today(tz_name: str) -> str:
    """Current calendar date (YYYY-MM-DD) in the given IANA timezone."""
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        tz = ZoneInfo("UTC")
    return datetime.now(tz).strftime("%Y-%m-%d")


def parse_date(value) -> date | None:
    """Parse a ``YYYY-MM-DD`` string into a date, tolerating junk/empty input."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def date_to_str(value: date | None) -> str | None:
    return value.isoformat() if value else None
