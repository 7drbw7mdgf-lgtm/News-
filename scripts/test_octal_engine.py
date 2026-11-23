"""Unit tests for PHEME-8 eight-valued logic and safe inference."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("pheme_octal", Path(__file__).resolve().parents[1] / "backend" / "octal_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class OctalEngineTests(unittest.TestCase):
    def test_operator_truth_tables(self):
        for a in range(8):
            self.assertEqual(engine.negate(a), 7 - a)
            self.assertEqual(engine.negate(engine.negate(a)), a)
            for b in range(8):
                self.assertEqual(engine.conjunction(a,b), min(a,b))
                self.assertEqual(engine.disjunction(a,b), max(a,b))
                self.assertEqual(engine.implies(a,b), min(7,7-a+b))
                self.assertEqual(engine.conjunction(a,b),engine.conjunction(b,a))
                self.assertEqual(engine.disjunction(a,b),engine.disjunction(b,a))

    def test_unknown_is_not_false(self):
        self.assertIsNone(engine.conjunction(None,7))
        self.assertIsNone(engine.disjunction(None,0))
        self.assertIsNone(engine.negate(None))
        self.assertIsNone(engine.implies(None,7))

    def test_rejects_boolean_out_of_range_and_injection(self):
        for v in (-1,8,True,False,3.5,"7"):
            with self.assertRaises(ValueError):
                engine.checked(v)
        with self.assertRaises(ValueError):
            engine.evaluate({"op":"VAR","name":"__import__('os')"}, {"P1":7})
        with self.assertRaises(ValueError):
            engine.evaluate({"op":"AND8","args":[{"op":"VAR","name":"P1"}]}, {"P1":7})

    def test_associativity(self):
        for a in range(8):
            for b in range(8):
                for c in range(8):
                    self.assertEqual(engine.conjunction(engine.conjunction(a,b),c), engine.conjunction(a,engine.conjunction(b,c)))

    def test_supported_inference_has_trace_and_no_order(self):
        result = engine.infer_from_corroboration({"propositions":[
            {"key":"bank-of-england:rate_cut","status":"cross-source-support","octalCorroboration":6,"supportingPublishers":3,"contradictingPublishers":0,"supporting":[]},
            {"key":"uk:inflation_down","status":"limited-cross-source-support","octalCorroboration":4,"supportingPublishers":1,"contradictingPublishers":0,"supporting":[]}
        ]})
        self.assertEqual(result["octalResult"],4)
        self.assertEqual(result["trace"]["op"],"AND8")
        self.assertEqual(result["status"],"supported")
        self.assertEqual(result["execution"],"disabled")

    def test_contested_forces_unknown(self):
        result = engine.infer_from_corroboration({"propositions":[
            {"key":"uk:inflation_down","status":"contested","octalCorroboration":6,"supportingPublishers":4,"contradictingPublishers":1}
        ]})
        self.assertEqual(result["status"],"contested")
        self.assertIsNone(result["octalResult"])

    def test_unverified_is_not_zero(self):
        result = engine.infer_from_corroboration({"propositions":[
            {"key":"uk:inflation_down","status":"unverified","octalCorroboration":None,"supportingPublishers":0}
        ]})
        self.assertEqual(result["status"],"unknown")
        self.assertIsNone(result["octalResult"])

    def test_no_propositions_is_unknown(self):
        result = engine.infer_from_corroboration({"propositions":[]})
        self.assertEqual(result["status"],"unknown")
        self.assertIsNone(result["octalResult"])

if __name__ == "__main__":
    unittest.main()
