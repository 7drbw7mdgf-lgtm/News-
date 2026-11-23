"""Read-only Trading 212 access for the operator's private account widget."""
from base64 import b64encode
from datetime import datetime, timezone
import hmac
import json
from math import isfinite
import os
import re
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


HOSTS = {"demo": "https://demo.trading212.com", "live": "https://live.trading212.com"}
SUMMARY = "/api/v0/equity/account/summary"
POSITIONS = "/api/v0/equity/positions"
REFRESH_INTERVAL = 10


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AccountWidget:
    def __init__(self):
        self.lock = Lock()
        self.until = 0
        self.result = None
        self.opener = build_opener(NoRedirect())

    def request(self, host, path, auth):
        request = Request(host + path, method="GET", headers={
            "Authorization": auth, "Accept": "application/json",
        })
        with self.opener.open(request, timeout=7) as response:
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ValueError("Trading 212 response exceeds the widget limit")
            return json.loads(raw)

    def account(self, authorization):
        token = os.environ.get("PHEME_TRADING212_WIDGET_TOKEN", "")
        key = os.environ.get("TRADING212_API_KEY", "")
        secret = os.environ.get("TRADING212_API_SECRET", "")
        mode = os.environ.get("TRADING212_ENV", "demo").lower()
        if not (re.fullmatch(r"[a-f0-9]{64}", token) and key and secret and mode in HOSTS):
            return 503, {"error": "not_configured"}
        provided = authorization or ""
        if len(provided) != 71 or not hmac.compare_digest(provided.encode(), b"Bearer " + token.encode()):
            return 401, {"error": "auth_required"}

        with self.lock:
            now = monotonic()
            if self.result is not None and now < self.until:
                return self.result
            auth = "Basic " + b64encode(f"{key}:{secret}".encode()).decode("ascii")
            retry_after = REFRESH_INTERVAL
            try:
                summary = self.request(HOSTS[mode], SUMMARY, auth)
                positions = self.request(HOSTS[mode], POSITIONS, auth)
                self.result = 200, widget_fields(summary, positions, mode)
            except HTTPError as error:
                code = error.code
                if code == 429:
                    retry_after = 60
                    self.result = 429, {"error": "broker_rate_limited"}
                elif code in (401, 403):
                    retry_after = 60
                    self.result = 502, {"error": "broker_access"}
                else:
                    self.result = 502, {"error": "broker_unavailable"}
                error.close()
            except (URLError, TimeoutError, OSError, ValueError, TypeError, OverflowError):
                self.result = 502, {"error": "broker_unavailable"}
            self.until = monotonic() + retry_after
            return self.result


def number(value):
    return value if type(value) in (float, int) and isfinite(value) else None


def widget_fields(summary, positions, mode):
    """Allow-list only the fields displayed in the authenticated panel."""
    if not isinstance(summary, dict) or not isinstance(summary.get("cash"), dict) or not isinstance(positions, list):
        raise ValueError("Unexpected Trading 212 account response")
    currency = summary.get("currency")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("Invalid account currency")
    output = []
    for row in positions:
        instrument = row.get("instrument") if isinstance(row, dict) else None
        if not isinstance(instrument, dict) or not isinstance(instrument.get("ticker"), str):
            raise ValueError("Unexpected Trading 212 position response")
        output.append({
            "ticker": instrument["ticker"][:64],
            "name": str(instrument.get("name") or instrument["ticker"])[:100],
            "quantity": number(row.get("quantity")),
        })
    return {
        "mode": mode,
        "asOf": datetime.now(timezone.utc).isoformat(),
        "currency": currency,
        "totalValue": number(summary.get("totalValue")),
        "availableCash": number(summary["cash"].get("availableToTrade")),
        "positions": output,
    }


WIDGET = AccountWidget()
