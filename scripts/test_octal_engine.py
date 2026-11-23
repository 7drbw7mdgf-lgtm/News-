"""Regression tests for PHEME-8 multiplication and evidence filtering."""
import importlib.util
import itertools
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("pheme_octal", Path(__file__).resolve().parents[1] / "backend" / "octal_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def claim(value, state="cross-source-support", contradictions=0):
    return {"key":"bank-of-england:rate_cut", "status":state,
            "octalCorroboration":value, "supportingPublishers":3,
            "contradictingPublishers":contradictions, "supporting":[], "contradicting":[]}


class OctalEngineTests(unittest.TestCase):
    def test_multiplication_range_and_exact_formula(self):
        for a,b in itertools.product(range(8), repeat=2):
            self.assertEqual(engine.multiply(a,b), (2*a*b+7)//14)
            self.assertEqual(engine.multiply(a,b),engine.multiply(b,a))
        self.assertEqual(engine.multiply(7,7),7)
        self.assertEqual(engine.multiply(7,4),4)
        self.assertEqual(engine.multiply(0,7),0)
        self.assertEqual(engine.multiply(5,6),4)

    def test_many_inputs_round_only_once(self):
        self.assertEqual(engine.multiply_many([6,5,4]), 2)
        self.assertEqual(engine.multiply_many([7,7,7]), 7)
        self.assertEqual(engine.multiply_many([7,4]),4)
        for values in itertools.product(range(8), repeat=3):
            for order in itertools.permutations(values):
                self.assertEqual(engine.multiply_many(order),engine.multiply_many(values))
        trail=engine.evaluate_product([6,5,4])
        self.assertEqual(trail["exact"],{"numerator":120,"denominator":49})

    def test_unknown_never_equals_zero(self):
        self.assertIsNone(engine.multiply(None, 7))
        self.assertIsNone(engine.multiply_many([7,None,4]))
        self.assertEqual(engine.multiply_many([0,7]),0)

    def test_rejects_invalid_input(self):
        for value in (-1,8,False,True,3.5,"7"):
            with self.assertRaises(ValueError):
                engine.checked(value)
        with self.assertRaises(ValueError):
            engine.multiply_many([])
        with self.assertRaises(ValueError):
            engine.multiply_many([7]*9)
        with self.assertRaises(ValueError):
            engine.threshold(True)

    def test_successful_inference(self):
        result=engine.infer_from_corroboration({"propositions":[claim(7),claim(7)]})
        self.assertEqual(result["status"],"supported")
        self.assertEqual(result["octalResult"],7)
        self.assertEqual(result["operator"],"MULTIPLY8")
        self.assertEqual(result["trace"]["pipeline"],["INPUT_FILTER","MULTIPLY8","OUTPUT_FILTER"])
        self.assertEqual(result["execution"],"disabled")

    def test_multiplication_can_fail_output_filter(self):
        result=engine.infer_from_corroboration({"propositions":[claim(5),claim(5)]})
        self.assertEqual(result["status"],"filtered")
        self.assertEqual(result["rawOctalResult"],4)
        self.assertIsNone(result["octalResult"])
        self.assertFalse(result["trace"]["outputFilter"]["pass"])

    def test_input_filter_does_not_silently_drop_weak_premise(self):
        result=engine.infer_from_corroboration({"propositions":[claim(7),claim(3)]})
        self.assertEqual(result["status"],"filtered")
        self.assertIsNone(result["rawOctalResult"])
        self.assertEqual(result["trace"]["filters"][1]["reason"],"below-input-floor")

    def test_conflict_vetoes_inference(self):
        result=engine.infer_from_corroboration({"propositions":[claim(7),claim(5,"contested",1)]})
        self.assertEqual(result["status"],"contested")
        self.assertIsNone(result["octalResult"])
        self.assertEqual(result["execution"],"disabled")

    def test_missing_stale_unverified_are_unknown(self):
        for state in ["unverified","unresolved","stale"]:
            result=engine.infer_from_corroboration({"propositions":[claim(None,state)]})
            self.assertEqual(result["status"],"unknown")
            self.assertIsNone(result["octalResult"])

    def test_configurable_thresholds(self):
        result=engine.infer_from_corroboration({"propositions":[claim(4),claim(4)]},
                                                input_floor=4,output_floor=2)
        self.assertEqual(result["octalResult"],2)
        with self.assertRaises(ValueError):
            engine.infer_from_corroboration({"propositions":[claim(7)]},input_floor=8)

    def test_no_propositions(self):
        result=engine.infer_from_corroboration({"propositions":[]})
        self.assertEqual(result["status"],"unknown")


if __name__=="__main__":
    unittest.main()
