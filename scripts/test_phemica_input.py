import json
from pathlib import Path
import unittest

from backend.phemica_input import build_input, plans_as_of


ROOT = Path(__file__).resolve().parents[1]
URL = "https://example.org/news/bremen"
OBSERVED = "2026-11-23T22:35:00+00:00"
EVENTS = json.loads((ROOT / "feeds" / "phemica-plan-events.json").read_text())


class PhemicaInputTest(unittest.TestCase):
    def snapshot(self, **changes):
        item = dict(publisher="Wire", title="Original headline", summary="RSS excerpt",
                    published="2026-11-23T18:00:00+00:00", status="rss",
                    context="Pheme editorial context", paragraphs=["Reader full text"])
        item.update(changes)
        return {"generatedAt": OBSERVED, "items": {URL: item}}

    def test_article_versions_and_observation_are_distinct(self):
        old = build_input(self.snapshot(), EVENTS)["articles"][0]
        repeated = self.snapshot()
        repeated["generatedAt"] = "2026-11-24T00:00:00+00:00"
        later = build_input(repeated, EVENTS)["articles"][0]
        changed = build_input(self.snapshot(title="Revised headline"), EVENTS)["articles"][0]

        self.assertNotEqual(old["publishedAt"], old["observedAt"])
        self.assertNotEqual(old["observedAt"], later["observedAt"])
        self.assertEqual(old["versionId"], later["versionId"])
        self.assertEqual(old["articleId"], changed["articleId"])
        self.assertNotEqual(old["versionId"], changed["versionId"])
        self.assertIsNone(old["originId"])
        self.assertNotIn("context", old)
        self.assertNotIn("paragraphs", old)

    def test_editorial_references_are_excluded_and_dates_are_not_invented(self):
        snapshot = self.snapshot(published="2026-11-23")
        snapshot["items"]["https://example.org/archive"] = {"status": "edition-reference"}
        feed = build_input(snapshot, EVENTS)
        self.assertEqual(len(feed["articles"]), 1)
        self.assertIsNone(feed["articles"][0]["publishedAt"])

    def test_bremen_as_of_and_stale_reprint(self):
        snapshot = self.snapshot(title="Reprint of original closure plan")
        feed = build_input(snapshot, list(reversed(EVENTS)))
        plan = EVENTS[0]["planId"]
        self.assertEqual(plans_as_of(feed, "2022-09-01"), {})
        self.assertEqual(plans_as_of(feed, "2022-09-29")[plan]["status"], "announced")
        self.assertEqual(plans_as_of(feed, "2022-09-30")[plan]["status"], "postponed")
        self.assertEqual(plans_as_of(feed, "2026-11-23")[plan]["status"], "postponed")
        self.assertEqual(len(feed["planEvents"]), 2)

    def test_conflicting_revision_chain_fails(self):
        bad = dict(EVENTS[1], supersedes=None)
        with self.assertRaisesRegex(ValueError, "supersede"):
            build_input(self.snapshot(), [EVENTS[0], bad])


if __name__ == "__main__":
    unittest.main()
