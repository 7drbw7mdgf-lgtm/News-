"""PHEME-8 primary cost branch model regression tests."""
import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location("pheme_primary_costs",Path(__file__).resolve().parents[1]/"backend"/"primary_costs.py")
model=importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


def evidence(score, **extra):
    return {"score":score,"corroborated":True,"contested":False,"sourceUrls":["https://publisher.example/article"],**extra}


class PrimaryCostTests(unittest.TestCase):
    def test_every_profile_references_registered_costs(self):
        self.assertGreaterEqual(len(model.COSTS),15)
        for industry,selected in model.PROFILES.items():
            self.assertTrue(selected)
            self.assertEqual(len(selected),len(set(selected)))
            self.assertTrue(set(selected)<=set(model.COSTS))
            self.assertEqual(len(model.taxonomy(industry)["categories"]),len(selected))

    def test_empty_data_remains_unknown_not_zero(self):
        result=model.aggregate("ai_infrastructure",{})
        self.assertIsNone(result["combinedScore"])
        self.assertTrue(all(x["status"]=="unknown" for x in result["branches"]))
        self.assertEqual(result["execution"],"disabled")

    def test_supported_branch_multiplies_with_exact_trace(self):
        result=model.aggregate("ai_infrastructure",{"energy":[evidence(6),evidence(5)]})
        energy=next(x for x in result["branches"] if x["cost"]=="energy")
        self.assertEqual(energy["score"],4)
        self.assertEqual(energy["trace"],{"operator":"MULTIPLY8","numerator":30,"denominator":7})

    def test_weak_signal_does_not_disappear(self):
        result=model.aggregate("ai_infrastructure",{"energy":[evidence(7),evidence(3)]})
        energy=next(x for x in result["branches"] if x["cost"]=="energy")
        self.assertEqual(energy["status"],"filtered")
        self.assertIsNone(energy["score"])

    def test_conflict_and_unknown_block_branch(self):
        result=model.aggregate("ai_infrastructure",{
            "energy":[evidence(7),evidence(6,contested=True)],
            "compute":[evidence(None)]
        })
        self.assertEqual(next(x for x in result["branches"] if x["cost"]=="energy")["status"],"contested")
        self.assertEqual(next(x for x in result["branches"] if x["cost"]=="compute")["status"],"unknown")

    def test_no_global_product_of_overlapping_costs(self):
        result=model.aggregate("ai_infrastructure",{
            "compute":[evidence(7)],
            "tariffs":[evidence(6)],
            "energy":[evidence(6)]
        })
        self.assertIsNone(result["combinedScore"])
        self.assertTrue(any({x["a"],x["b"]}=={"compute","tariffs"} for x in result["overlapReview"]))

    def test_irrelevant_costs_not_added_to_company_profile(self):
        result=model.aggregate("software_ai",{"construction":[evidence(7)]})
        self.assertNotIn("construction",[x["cost"] for x in result["branches"]])

    def test_invalid_inputs_rejected(self):
        for bad in [8,True,-1,3.5,"6"]:
            with self.assertRaises(ValueError):
                model.aggregate("manufacturing",{"energy":[evidence(bad)]})
        with self.assertRaises(ValueError):
            model.aggregate("unknown",{})
        with self.assertRaises(ValueError):
            model.aggregate("software_ai",{"gibberish":[evidence(4)]})
        with self.assertRaises(ValueError):
            model.aggregate("software_ai",{"energy":[evidence(7,sourceUrls=["file:///x"])]})


if __name__=="__main__":
    unittest.main()
