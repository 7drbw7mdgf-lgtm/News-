import base64
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend import server, trading212


TOKEN = "a" * 64
AUTH = "Bearer " + TOKEN
ENV = {
    "PHEME_TRADING212_WIDGET_TOKEN": TOKEN,
    "TRADING212_API_KEY": "example-key",
    "TRADING212_API_SECRET": "example-secret",
    "TRADING212_ENV": "demo",
}
SUMMARY = {"id": 123, "currency": "GBP", "cash": {"availableToTrade": 10}, "totalValue": 52}
POSITIONS = [{"instrument": {"ticker": "EXAMPLE_EQ", "name": "Example"}, "quantity": 2}]


class Trading212Tests(unittest.TestCase):
    def test_configuration_and_authentication_fail_before_requests(self):
        widget = trading212.AccountWidget()
        with patch.object(widget, "request") as request:
            with patch.dict("os.environ", {}, clear=True):
                self.assertEqual(widget.account(None), (503, {"error": "not_configured"}))
            with patch.dict("os.environ", ENV, clear=True):
                self.assertEqual(widget.account("Bearer " + "b" * 64), (401, {"error": "auth_required"}))
            request.assert_not_called()

    def test_only_two_read_paths_and_no_account_identifier(self):
        widget = trading212.AccountWidget()
        with patch.dict("os.environ", ENV, clear=True):
            with patch.object(widget, "request", side_effect=[SUMMARY, POSITIONS]) as request:
                code, data = widget.account("Bearer " + TOKEN)
                self.assertEqual(widget.account("Bearer " + TOKEN), (code, data))
        self.assertEqual(code, 200)
        self.assertEqual(data["positions"], [{"ticker": "EXAMPLE_EQ", "name": "Example", "quantity": 2}])
        self.assertNotIn("id", data)
        self.assertEqual(data["availableCash"], 10)
        self.assertEqual(data["mode"], "demo")
        auth = "Basic " + base64.b64encode(b"example-key:example-secret").decode()
        self.assertEqual([call.args for call in request.call_args_list], [
            ("https://demo.trading212.com", "/api/v0/equity/account/summary", auth),
            ("https://demo.trading212.com", "/api/v0/equity/positions", auth),
        ])

    def test_handles_broker_rate_limits_without_exposing_response(self):
        widget = trading212.AccountWidget()
        error = HTTPError("https://demo.trading212.com", 429, "hidden", {}, BytesIO(b"private"))
        with patch.dict("os.environ", ENV, clear=True):
            with patch.object(widget, "request", side_effect=error) as request:
                self.assertEqual(widget.account("Bearer " + TOKEN), (429, {"error": "broker_rate_limited"}))
                self.assertEqual(widget.account("Bearer " + TOKEN), (429, {"error": "broker_rate_limited"}))
        request.assert_called_once()

    def test_live_and_opted_out_accounts_cannot_use_demo_orders(self):
        widget = trading212.AccountWidget()
        with patch.object(widget, "request") as request:
            for config in (ENV, {**ENV, "TRADING212_ENV": "live", "PHEME_TRADING212_DEMO_ORDERS": "true"}):
                with patch.dict("os.environ", config, clear=True):
                    self.assertEqual(widget.pending(AUTH), (403, {"error": "demo_orders_disabled"}))
                    self.assertEqual(widget.preview(AUTH, {})[0], 403)
                    self.assertEqual(widget.confirm(AUTH, {})[0], 403)
            request.assert_not_called()

    @patch.dict("os.environ", {**ENV, "PHEME_TRADING212_DEMO_ORDERS": "true"}, clear=True)
    def test_preview_validates_and_confirm_uses_exact_single_use_demo_intent(self):
        widget = trading212.AccountWidget()
        auth = "Basic " + base64.b64encode(b"example-key:example-secret").decode()
        sell = {"action": "market", "ticker": "EXAMPLE_EQ", "side": "sell", "quantity": 1.5}
        with patch.object(widget, "request", return_value={"id": 123, "status": "NEW"}) as request:
            self.assertEqual(widget.preview("Bearer " + "b" * 64, sell)[0], 401)
            self.assertEqual(widget.preview(AUTH, {**sell, "quantity": -1})[0], 400)
            code, preview = widget.preview(AUTH, sell)
            self.assertEqual(code, 200)
            self.assertEqual(preview["order"], sell)
            request.assert_not_called()
            payload = {"ticket": preview["ticket"], "ticker": "CHANGED_EQ"}
            code, receipt = widget.confirm(AUTH, payload)
            self.assertEqual(code, 200)
            self.assertEqual((receipt["outcome"], receipt["orderId"]), ("submitted", "123"))
            self.assertEqual(widget.confirm(AUTH, payload), (409, {"error": "preview_expired_or_used"}))
            request.assert_called_once_with(trading212.HOSTS["demo"], trading212.ORDERS + "/market",
                                            auth, method="POST", body={
                                                "ticker": "EXAMPLE_EQ", "quantity": -1.5, "extendedHours": False,
                                            })

    @patch.dict("os.environ", {**ENV, "PHEME_TRADING212_DEMO_ORDERS": "true"}, clear=True)
    def test_pending_and_cancellation_use_exact_order_id(self):
        widget = trading212.AccountWidget()
        order = {"id": 9223372036854775807, "ticker": "EXAMPLE_EQ", "quantity": 2, "status": "NEW", "account": 123}
        with patch.object(widget, "request", side_effect=[[order], None]) as request:
            self.assertEqual(widget.pending(AUTH), (200, {"orders": [{
                "orderId": str(order["id"]), "ticker": order["ticker"], "quantity": 2, "status": "NEW",
            }]}))
            self.assertEqual(widget.preview(AUTH, {"action": "cancel", "orderId": "1/2"})[0], 400)
            _, preview = widget.preview(AUTH, {"action": "cancel", "orderId": str(order["id"])})
            self.assertEqual(request.call_count, 1)
            self.assertEqual(widget.confirm(AUTH, {"ticket": preview["ticket"]}),
                             (200, {"outcome": "cancellation_requested", "orderId": str(order["id"])}))
            self.assertEqual(request.call_args.args[:2], (trading212.HOSTS["demo"],
                                                         trading212.ORDERS + "/" + str(order["id"])))
            self.assertEqual(request.call_args.kwargs, {"method": "DELETE"})

    @patch.dict("os.environ", {**ENV, "PHEME_TRADING212_DEMO_ORDERS": "true"}, clear=True)
    def test_confirm_timeout_does_not_allow_repeat_submission(self):
        widget = trading212.AccountWidget()
        _, preview = widget.preview(AUTH, {"action": "market", "ticker": "EXAMPLE_EQ", "side": "buy", "quantity": 2})
        with patch.object(widget, "request", side_effect=TimeoutError) as request:
            self.assertEqual(widget.confirm(AUTH, {"ticket": preview["ticket"]}),
                             (502, {"error": "order_outcome_unknown"}))
            self.assertEqual(widget.confirm(AUTH, {"ticket": preview["ticket"]})[0], 409)
            self.assertEqual(request.call_args.kwargs["body"]["quantity"], 2)
            request.assert_called_once()

    def test_http_headers_prevent_shared_caching_and_isolate_widget(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), server.Handler) as http:
            thread = Thread(target=http.serve_forever, daemon=True)
            thread.start()
            root = f"http://127.0.0.1:{http.server_port}"
            try:
                with urlopen(root + "/trading212/widget", timeout=3) as r:
                    self.assertIn("frame-ancestors 'self' https://pheme24.online",
                                  r.headers["Content-Security-Policy"])
                    self.assertIn(b"/trading212/widget.js", r.read())
                with patch.object(server.BROKER.WIDGET, "account", return_value=(200, {"mode": "demo"})):
                    request = Request(root + "/v1/trading212/account",
                                      headers={"Origin": "https://pheme24.online"})
                    with urlopen(request, timeout=3) as r:
                        self.assertEqual(r.headers["Cache-Control"], "no-store")
                        self.assertIsNone(r.headers.get("Access-Control-Allow-Origin"))
                        self.assertEqual(json.load(r), {"mode": "demo"})
                order = {"action": "market", "ticker": "EXAMPLE_EQ", "side": "buy", "quantity": 1}
                with patch.dict("os.environ", {**ENV, "PHEME_TRADING212_DEMO_ORDERS": "true"}, clear=True):
                    with patch.object(server.BROKER.WIDGET, "request", return_value={"id": 22}) as broker:
                        headers = {"Content-Type": "application/json", "Authorization": AUTH}
                        connection = HTTPConnection("127.0.0.1", http.server_port, timeout=3)
                        try:
                            connection.request("POST", "/v1/trading212/orders/preview",
                                               json.dumps(order), headers)
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.headers["Cache-Control"], "no-store")
                            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
                            ticket = json.load(response)["ticket"]
                            broker.assert_not_called()
                            connection.request("POST", "/v1/trading212/orders/confirm",
                                               json.dumps({"ticket": ticket}), headers)
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertEqual(json.load(response)["orderId"], "22")
                        finally:
                            connection.close()
                        broker.assert_called_once()
            finally:
                http.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
