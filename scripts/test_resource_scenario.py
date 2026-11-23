"""Stage 5 simulation: coefficient validity, missing values and shared-path safety."""
import copy
import importlib.util
import unittest
from pathlib import Path

base=Path(__file__).resolve().parents[1]/"backend"
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,base/filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

graph=load("resource_graph","resource_graph.py")
model=load("resource_scenario","resource_scenario.py")

class ScenarioTests(unittest.TestCase):
    def test_initial_demo_path_is_explicit_and_deterministic(self):
        data=model.demo_graph(graph.EXAMPLE)
        result=model.simulate(data,"gas",20,graph.validate)
        rows={r["node"]:r for r in result["results"]}
        self.assertEqual(rows["gas"]["changePercent"],20)
        self.assertEqual(rows["power"]["changePercent"],5.6)
        self.assertAlmostEqual(rows["dc"]["changePercent"],1.12)
        self.assertAlmostEqual(rows["margin"]["changePercent"],.448)
        self.assertIsNone(rows["chips"]["changePercent"])
        self.assertEqual(result["execution"],"disabled")

    def test_unknown_assumptions_do_not_become_zero(self):
        result=model.simulate(graph.EXAMPLE,"gas",20,graph.validate)
        self.assertTrue(all(r["status"]=="unreached" for r in result["results"] if r["node"]!="gas"))

    def test_convergent_routes_are_blocked(self):
        data=model.demo_graph(graph.EXAMPLE)
        for edge in data["edges"]:
            if (edge["source"],edge["target"]) in (
                ("power","semifab"),("semifab","chips"),("chips","dc")
            ):
                edge["passThrough"]=0.5
        result=model.simulate(data,"gas",20,graph.validate)
        rows={r["node"]:r for r in result["results"]}
        self.assertEqual(rows["dc"]["status"],"overlap-review-required")
        self.assertIsNone(rows["dc"]["changePercent"])
        self.assertEqual(rows["margin"]["status"],"overlap-review-required")
        self.assertIsNone(rows["margin"]["changePercent"])

    def test_invalid_coefficients_rejected(self):
        for value in [-0.1,1.1,True,float("nan")]:
            data=model.demo_graph(graph.EXAMPLE)
            data["edges"][0]["passThrough"]=value
            with self.assertRaises(ValueError):
                model.simulate(data,"gas",20,graph.validate)

    def test_shock_validation(self):
        data=model.demo_graph(graph.EXAMPLE)
        for shock in ["missing","margin","dc"]:
            with self.assertRaises(ValueError):
                model.simulate(data,shock,20,graph.validate)
        for value in [float("inf"),float("nan"),True,101,-101]:
            with self.assertRaises(ValueError):
                model.simulate(data,"gas",value,graph.validate)


if __name__=="__main__":
    unittest.main()
