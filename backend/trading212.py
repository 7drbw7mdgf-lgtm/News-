"""Trading 212 account access and confirmed demo orders for the operator's private account widget."""
from base64 import b64encode
from datetime import datetime, timezone
import hmac
from http.client import HTTPException
import json
from math import isfinite
import os
import re
from secrets import token_urlsafe
from threading import Lock
from time import monotonic
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


HOSTS = {"demo": "https://demo.trading212.com", "live": "https://live.trading212.com"}
SUMMARY = "/api/v0/equity/account/summary"
POSITIONS = "/api/v0/equity/positions"
ORDERS = "/api/v0/equity/orders"
REFRESH_INTERVAL = 10
PREVIEW_LIFETIME = 90
MAX_PREVIEWS = 64


def orders_enabled(mode):
    return mode == "demo" and os.environ.get("PHEME_TRADING212_DEMO_ORDERS", "").lower() == "true"


def credentials(authorization):
    token = os.environ.get("PHEME_TRADING212_WIDGET_TOKEN", "")
    key = os.environ.get("TRADING212_API_KEY", "")
    secret = os.environ.get("TRADING212_API_SECRET", "")
    mode = os.environ.get("TRADING212_ENV", "demo").lower()
    if not (re.fullmatch(r"[a-f0-9]{64}", token) and key and secret and mode in HOSTS):
        return 503, {"error": "not_configured"}
    provided = authorization or ""
    if len(provided) != 71 or not hmac.compare_digest(provided.encode(), b"Bearer " + token.encode()):
        return 401, {"error": "auth_required"}
    auth = "Basic " + b64encode(f"{key}:{secret}".encode()).decode("ascii")
    return 200, (mode, auth)


def order_intent(data):
    if data.get("action") == "cancel":
        order_id = data.get("orderId")
        if isinstance(order_id, str) and re.fullmatch(r"[1-9][0-9]{0,18}", order_id):
            return {"action": "cancel", "orderId": order_id}
    if data.get("action") == "market":
        ticker, side = data.get("ticker"), data.get("side")
        quantity = number(data.get("quantity"))
        if (isinstance(ticker, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", ticker)
                and side in ("buy", "sell") and quantity is not None and quantity > 0):
            return {"action": "market", "ticker": ticker, "side": side, "quantity": quantity}
    raise ValueError("Invalid order intent")


def order_fields(order):
    order_id = order.get("id")
    if type(order_id) is not int or not 0 < order_id < 10 ** 19:
        raise ValueError("Invalid Trading 212 order ID")
    return {
        "orderId": str(order_id),
        "ticker": str(order.get("ticker", ""))[:64],
        "quantity": number(order.get("quantity")),
        "status": str(order.get("status", ""))[:40],
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AccountWidget:
    def __init__(self):
        self.lock = Lock()
        self.until = 0
        self.result = None
        self.preview_lock = Lock()
        self.previews = {}
        self.pending_lock = Lock()
        self.pending_until = 0
        self.pending_result = None
        self.pending_auth = None
        self.opener = build_opener(NoRedirect())

    def request(self, host, path, auth, method="GET", body=None):
        headers = {"Authorization": auth, "Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, allow_nan=False).encode()
        request = Request(host + path, method=method, headers=headers, data=payload)
        with self.opener.open(request, timeout=7) as response:
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ValueError("Trading 212 response exceeds the widget limit")
            if method == "DELETE":
                return None
            return json.loads(raw)

    def account(self, authorization):
        code, result = credentials(authorization)
        if code != 200:
            return code, result
        mode, auth = result
        with self.lock:
            now = monotonic()
            if self.result is not None and now < self.until:
                return self.result
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
            except (OSError, HTTPException, ValueError, TypeError, OverflowError):
                self.result = 502, {"error": "broker_unavailable"}
            self.until = monotonic() + retry_after
            return self.result

    def demo_credentials(self, authorization):
        code, result = credentials(authorization)
        if code != 200:
            return code, result
        mode, auth = result
        if not orders_enabled(mode):
            return 403, {"error": "demo_orders_disabled"}
        return 200, auth

    def pending(self, authorization):
        code, auth = self.demo_credentials(authorization)
        if code != 200:
            return code, auth
        with self.pending_lock:
            if auth == self.pending_auth and monotonic() < self.pending_until:
                return self.pending_result
            interval = REFRESH_INTERVAL
            try:
                orders = self.request(HOSTS["demo"], ORDERS, auth)
                if not isinstance(orders, list):
                    raise ValueError("Invalid Trading 212 pending orders response")
                result = 200, {"orders": [order_fields(order) for order in orders]}
            except HTTPError as error:
                result = 502, {"error": "broker_access" if error.code in (401, 403) else "broker_unavailable"}
                if error.code == 429:
                    result = 429, {"error": "broker_rate_limited"}
                    interval = 60
                error.close()
            except (OSError, HTTPException, ValueError, TypeError, AttributeError, OverflowError):
                result = 502, {"error": "broker_unavailable"}
            self.pending_auth = auth
            self.pending_until = monotonic() + interval
            self.pending_result = result
            return result

    def preview(self, authorization, data):
        code, auth = self.demo_credentials(authorization)
        if code != 200:
            return code, auth
        try:
            intent = order_intent(data)
        except (ValueError, OverflowError):
            return 400, {"error": "invalid_order"}
        with self.preview_lock:
            now = monotonic()
            self.previews = {ticket: entry for ticket, entry in self.previews.items() if entry[0] > now}
            if len(self.previews) >= MAX_PREVIEWS:
                return 429, {"error": "too_many_previews"}
            ticket = token_urlsafe(24)
            self.previews[ticket] = (now + PREVIEW_LIFETIME, authorization, auth, intent)
        return 200, {"ticket": ticket, "expiresIn": PREVIEW_LIFETIME, "order": intent}

    def confirm(self, authorization, data):
        code, auth = self.demo_credentials(authorization)
        if code != 200:
            return code, auth
        ticket = data.get("ticket")
        if not isinstance(ticket, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", ticket):
            return 400, {"error": "invalid_order"}
        with self.preview_lock:
            entry = self.previews.pop(ticket, None)
        if not entry or entry[0] <= monotonic() or entry[1:3] != (authorization, auth):
            return 409, {"error": "preview_expired_or_used"}
        intent = entry[3]
        try:
            if intent["action"] == "cancel":
                order_id = intent["orderId"]
                self.request(HOSTS["demo"], ORDERS + "/" + order_id, auth, method="DELETE")
                return 200, {"outcome": "cancellation_requested", "orderId": order_id}
            quantity = intent["quantity"] if intent["side"] == "buy" else -intent["quantity"]
            order = self.request(HOSTS["demo"], ORDERS + "/market", auth, method="POST", body={
                "ticker": intent["ticker"], "quantity": quantity, "extendedHours": False,
            })
            return 200, {"outcome": "submitted", **order_fields(order)}
        except HTTPError as error:
            code = error.code
            error.close()
            if code in (400, 401, 403, 404, 409, 422, 429):
                return 422, {"error": "broker_rejected"}
        except (OSError, HTTPException, ValueError, TypeError, AttributeError, OverflowError):
            pass
        return 502, {"error": "order_outcome_unknown"}


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
        "demoOrdersEnabled": orders_enabled(mode),
        "asOf": datetime.now(timezone.utc).isoformat(),
        "currency": currency,
        "totalValue": number(summary.get("totalValue")),
        "availableCash": number(summary["cash"].get("availableToTrade")),
        "positions": output,
    }


WIDGET = AccountWidget()
