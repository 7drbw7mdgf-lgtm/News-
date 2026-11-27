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

    def keys(self, title):
        return [(p["key"], p["stance"]) for p in
                engine.propositions_for_article("https://a.example/x", article("Paper", title), NOW)]

    def test_different_companies_do_not_corroborate_earnings(self):
        items = {
            "https://a.example/1": article("First paper", "UK retailer Tesco profits beat expectations"),
            "https://b.example/2": article("Second paper", "BP profits beat estimates in UK results season"),
            "https://c.example/3": article("Third paper", "Unilever revenue tops consensus, a boost for British shares"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["key"], "company:tesco:earnings_beat")
        self.assertEqual(result["propositions"][0]["supportingPublishers"], 0)

    def test_same_company_earnings_corroborate(self):
        items = {
            "https://a.example/1": article("First paper", "Tesco profits beat expectations"),
            "https://b.example/2": article("Second paper", "Tesco Plc full-year profit beats forecasts"),
        }
        result = engine.corroborate("https://a.example/1", items, NOW)
        self.assertEqual(result["propositions"][0]["octalCorroboration"], 4)

    def test_earnings_need_a_named_directory_company(self):
        self.assertEqual(self.keys("Record profits beat expectations"), [])
        self.assertEqual(self.keys("UK profits beat expectations"), [])

    def test_beating_a_forecast_is_not_a_hedge(self):
        self.assertEqual(self.keys("Rolls-Royce profit beats forecast"),
                         [("company:rolls-royce:earnings_beat", "for")])
        self.assertEqual(self.keys("Tesco profits could beat expectations"),
                         [("company:tesco:earnings_beat", "qualified")])

    def test_pronoun_us_is_not_the_united_states(self):
        self.assertEqual(self.keys("Inflation cools, giving us some relief"), [])
        self.assertEqual(self.keys("US inflation cools in October"), [("us:inflation_down", "for")])

    def test_each_claim_takes_its_nearest_entity(self):
        self.assertEqual(self.keys("BoE holds as UK inflation falls to 2.1%"), [("uk:inflation_down", "for")])
        items = {
            "https://a.example/1": article("First paper", "BoE holds as UK inflation falls to 2.1%"),
            "https://b.example/2": article("Second paper", "UK inflation falls for third month"),
        }
        self.assertEqual(engine.corroborate("https://a.example/1", items, NOW)["propositions"][0]["supportingPublishers"], 1)

    def test_country_and_central_bank_rate_claims_match(self):
        items = {
            "https://a.example/1": article("First paper", "Fed cuts rates by a quarter point"),
            "https://b.example/2": article("Second paper", "US cuts interest rates again"),
        }
        self.assertEqual(engine.corroborate("https://a.example/1", items, NOW)["propositions"][0]["supportingPublishers"], 1)

    def test_common_rate_phrasing_and_exclusions(self):
        self.assertEqual(self.keys("Fed cuts rates by a quarter point"), [("federal-reserve:rate_cut", "for")])
        self.assertEqual(self.keys("Fed rate cut lands as expected"), [("federal-reserve:rate_cut", "qualified")])
        self.assertEqual(self.keys("Fed raises rates"), [("federal-reserve:rate_cut", "against")])
        self.assertEqual(self.keys("Rate cut hopes rise at the Fed"), [("federal-reserve:rate_cut", "qualified")])
        self.assertEqual(self.keys("Barclays cuts mortgage rates after Bank of England decision"), [])
        self.assertEqual(self.keys("Bank of England cuts growth forecast as rates stay high"), [])

    def test_copy_of_target_headline_never_counts(self):
        for copy_time in ("2026-11-23T09:30:00+00:00", "2026-11-23T08:30:00+00:00"):
            items = {
                "https://a.example/1": article("First paper", "Bank of England cuts interest rates"),
                "https://b.example/2": article("Wire reprint", "Bank of England cuts interest rates", published=copy_time),
            }
            result = engine.corroborate("https://a.example/1", items, NOW)
            self.assertEqual(result["propositions"][0]["supportingPublishers"], 0, copy_time)


if __name__ == "__main__":
    unittest.main()
