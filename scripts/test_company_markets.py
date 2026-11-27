import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('company_markets', Path(__file__).with_name('collect-company-markets.py'))
company = importlib.util.module_from_spec(spec)
spec.loader.exec_module(company)


class CompanyMarketsTest(unittest.TestCase):
    def run_collector(self, env, responses=None):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'company-market-data.json'
            with mock.patch.object(company, 'OUT', out), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(company, 'get_json', side_effect=responses or (lambda *a: {})):
                company.main()
            return json.loads(out.read_text())

    def test_publishes_nothing_without_the_licence_flag(self):
        data = self.run_collector({'TWELVE_DATA_API_KEY': 'k'})
        self.assertEqual(data['status'], 'awaiting-licence')
        self.assertEqual(data['quotes'], {})
        self.assertEqual(data['history'], {})

    def test_collects_sorted_history_when_licensed(self):
        def fake(url, params):
            if url.endswith('/time_series'):
                values = [{'datetime': '2026-%02d-%02d' % (1 + i // 28, 1 + i % 28), 'close': str(100 + i)} for i in range(40)]
                return {'status': 'ok', 'values': list(reversed(values))}
            return {'status': 'error'}
        data = self.run_collector({'PHEME_MARKET_DATA_PUBLIC_DISPLAY': 'approved', 'TWELVE_DATA_API_KEY': 'k'}, fake)
        self.assertEqual(data['status'], 'available')
        points = data['history']['AAPL']
        self.assertEqual(len(points), 40)
        self.assertLess(points[0]['date'], points[-1]['date'])


if __name__ == '__main__':
    unittest.main()
