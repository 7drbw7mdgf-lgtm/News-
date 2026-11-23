"""Regression tests for the conservative Pheme-8 cross-publisher prototype."""
import datetime
import importlib.util
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "backend" / "corroboration.py"
spec = importlib.util.spec_from_file_location("pheme_corroboration", SOURCE)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
NOW = datetime.datetime(2026, 11, 23, 10, 0, tzinfo=datetime.timezone.utc)


def article(name, title, published="2026-11-23T09:00:00+00:00", summary="", status="rss"):
    return {"publisher": name, "title": title, "published": published, "summary": summary, "status": status}


class CorroborationTests(unittest.TestCase):
    def test_same_event_across_independent_publishers(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://b.example/2": article("Second paper", "BoE reduces interest rates today"),
            "https://c.example/3": article("Third paper", "Bank of England lowers interest rates"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["octalCorroboration"], 5)
        self.assertEqual(result["propositions"][0]["supportingPublishers"], 2)

    def test_same_publisher_does_not_count_as_independent(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://a.example/2": article("First paper", "BoE lowers interest rates"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertIsNone(result["propositions"][0]["octalCorroboration"])

    def test_denial_does_not_confirm(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://b.example/2": article("Second paper", "Bank of England rules out cuts to interest rates"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["supportingPublishers"], 0)

    def test_no_claim_from_editorial_reference(self):
        items = {"https://a.example/1": article("First paper", "Bank of England cuts interest rates", status="edition-reference")}
        self.assertEqual(engine.corroborate("https://a.example/1", items, NOW)["propositions"], [])

    def test_missing_date_does_not_confirm(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://b.example/2": article("Second paper", "BoE lowers interest rates", published=""),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["supportingPublishers"], 0)

    def test_independent_credible_source_not_assumed_from_score(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://b.example/2": article("Second paper", "BoE lowers interest rates"),
        }
        data = engine.corroborate("https://a.example/1", items, NOW)["propositions"][0]
        self.assertEqual(data["octalCorroboration"], 4)
        self.assertIn("NOT proposition truth", data["scoreMeaning"])

    def test_unrelated_entities_do_not_corroborrate(self):
        items = {
            "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
            "https://b.example/2": article("Second paper", "Federal Reserve cuts interest rates"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["supportingPublishers"], 0)


if __name__ == "__main__":
    unittest.main()
