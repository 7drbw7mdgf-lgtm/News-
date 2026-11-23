"""Stage 3 typed production network constraints and seed regression tests."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location("pheme_resource_graph",Path(__file__).resolve().parents[1]/"backend"/"resource_graph.py")
model=importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


class ResourceGraphTests(unittest.TestCase):
    def test_demo_graph(self):
        result=model.validate(model.EXAMPLE)
        self.assertTrue(result["valid"])
        self.assertEqual(result["nodeCount"],12)
        self.assertEqual(result["edgeCount"],12)

    def test_all_relationship_pairs_are_typed(self):
        for relation,pairs in model.RELATIONS.items():
            for a,b in pairs:
                self.assertIn(a,model.NODE_TYPES)
                self.assertIn(b,model.NODE_TYPES)

    def test_rejects_wrong_direction(self):
        data=copy.deepcopy(model.EXAMPLE)
        data["edges"].append({"source":"margin","target":"gas","relation":"supplies"})
        with self.assertRaises(ValueError):
            model.validate(data)

    def test_rejects_unknown_and_duplicate_nodes(self):
        data=copy.deepcopy(model.EXAMPLE)
        data["nodes"].append(dict(data["nodes"][0]))
        with self.assertRaises(ValueError):
            model.validate(data)
        data=copy.deepcopy(model.EXAMPLE)
        data["edges"].append({"source":"absent","target":"gas","relation":"supplies"})
        with self.assertRaises(ValueError):
            model.validate(data)

    def test_cycle_is_rejected_even_if_each_edge_type_is_legal(self):
        data={"nodes":[
            {"id":"a","label":"Process A","type":"process"},
            {"id":"b","label":"Process B","type":"process"}
        ],"edges":[
            {"source":"a","target":"b","relation":"produces"},
            {"source":"b","target":"a","relation":"produces"},
        ]}
        with self.assertRaisesRegex(ValueError,"Cycle"):
            model.validate(data)

    def test_units_required_for_quantities(self):
        data=copy.deepcopy(model.EXAMPLE)
        data["edges"][0]["quantity"]=3
        with self.assertRaises(ValueError):
            model.validate(data)
        data["edges"][0]["unit"]="MWh"
        self.assertTrue(model.validate(data)["valid"])
        data["edges"][0]["quantity"]=-1
        with self.assertRaises(ValueError):
            model.validate(data)

    def test_self_edges_and_duplicate_edges_rejected(self):
        data=copy.deepcopy(model.EXAMPLE)
        data["edges"].append(dict(data["edges"][0]))
        with self.assertRaises(ValueError):
            model.validate(data)
        data=copy.deepcopy(model.EXAMPLE)
        data["edges"].append({"source":"gas","target":"gas","relation":"requires"})
        with self.assertRaises(ValueError):
            model.validate(data)


if __name__=="__main__":
    unittest.main()
