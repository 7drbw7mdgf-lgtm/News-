import base64
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
            finally:
                http.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
