"""Stage 4 tests: RSS headline propositions linked to typed resources."""
import datetime
import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location("pheme_resource_evidence",Path(__file__).resolve().parents[1]/"backend"/"resource_evidence.py")
model=importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)
NOW=datetime.datetime(2026,11,23,12,0,tzinfo=datetime.timezone.utc)


def article(publisher, title, published="2026-11-23T11:00:00+00:00", status="rss"):
    return {"publisher":publisher,"title":title,"published":published,"status":status}


class ResourceEvidenceTests(unittest.TestCase):
    def test_cross_publisher_directional_corroboration(self):
        items={
            "https://a.example/1":article("A","Natural gas prices rise sharply"),
            "https://b.example/2":article("B","LNG prices surge in Europe"),
        }
        data=model.resource_evidence(items,"gas",NOW)["resources"]["gas"]
        self.assertEqual(data["status"],"cross-source-candidate")
        self.assertEqual(data["octalCorroboration"],4)
        self.assertEqual(data["direction"],"up")
        self.assertEqual(data["publisherCount"],2)
        self.assertEqual(data["evidenceType"],"RSS headline keyword-and-direction candidate")

    def test_opposing_directions_contested(self):
        items={
            "https://a.example/1":article("A","Copper prices surge"),
            "https://b.example/2":article("B","Copper prices plunge and fall"),
        }
        data=model.resource_evidence(items,"copper",NOW)["resources"]["copper"]
        self.assertEqual(data["status"],"contested")
        self.assertIsNone(data["octalCorroboration"])

    def test_same_publisher_is_not_independent(self):
        items={
            "https://a.example/1":article("A","Natural gas prices rise"),
            "https://a.example/2":article("A","LNG prices surge"),
        }
        data=model.resource_evidence(items,"gas",NOW)["resources"]["gas"]
        self.assertEqual(data["status"],"unverified")
        self.assertIsNone(data["octalCorroboration"])

    def test_qualified_and_negated_not_confirmed(self):
        items={
            "https://a.example/1":article("A","Natural gas prices may rise"),
            "https://b.example/2":article("B","Natural gas prices will not rise"),
        }
        data=model.resource_evidence(items,"gas",NOW)["resources"]["gas"]
        self.assertEqual(data["status"],"unverified")
        self.assertEqual(data["publisherCount"],0)

    def test_stale_and_editorial_references_excluded(self):
        items={
            "https://a.example/1":article("A","Copper prices rise","2025-01-01T00:00:00Z"),
            "https://b.example/2":article("B","Copper prices surge",status="edition-reference"),
        }
        data=model.resource_evidence(items,"copper",NOW)["resources"]["copper"]
        self.assertEqual(data["status"],"no-evidence")
        self.assertEqual(data["articles"],[])

    def test_undated_not_treated_as_fresh(self):
        a=article("A","Natural gas prices rise",published="")
        self.assertEqual(model.extract(a,"https://a.example/1",NOW),[])

    def test_unknown_custom_node_has_no_fabricated_score(self):
        value=model.resource_evidence({},"custom-resource",NOW)
        self.assertEqual(value["status"],"unsupported")
        self.assertIsNone(value["octalCorroboration"])

    def test_same_syndicated_headline_does_not_corroborrate(self):
        items={
            "https://a.example/1":article("A","Natural gas prices rise"),
            "https://b.example/2":article("B","Natural gas prices rise"),
        }
        data=model.resource_evidence(items,"gas",NOW)["resources"]["gas"]
        self.assertIsNone(data["octalCorroboration"])


if __name__=="__main__":
    unittest.main()
