import datetime as dt
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('update_forex', Path(__file__).with_name('update-forex.py'))
forex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forex)


def ecb_xml(days):
    cubes = []
    start = dt.date(2026, 10, 1)
    for i in range(days):
        date = (start + dt.timedelta(days=i)).isoformat()
        rates = ''.join('<Cube currency="%s" rate="%s"/>' % (code, 1 + i / 1000 + n)
                        for n, code in enumerate(['USD', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'INR', 'CNY', 'SEK']))
        cubes.append('<Cube time="%s">%s</Cube>' % (date, rates))
    # The ECB lists the newest day first.
    return ('<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" '
            'xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject>'
            '<Cube>%s</Cube></gesmes:Envelope>' % ''.join(reversed(cubes))).encode()


class ForexTest(unittest.TestCase):
    def test_parses_ecb_xml_ascending_with_only_shown_currencies(self):
        data = forex.build(ecb_xml(25))
        self.assertEqual(len(data['days']), 25)
        self.assertEqual(data['days'][0]['date'], '2026-10-01')
        self.assertEqual(data['asOf'], '2026-10-25')
        self.assertEqual(sorted(data['days'][0]['rates']), sorted(forex.CURRENCIES))
        self.assertNotIn('SEK', data['days'][-1]['rates'])

    def test_rejects_too_little_history(self):
        with self.assertRaises(ValueError):
            forex.build(ecb_xml(5))

    def test_rejects_bad_rates(self):
        data = forex.build(ecb_xml(25))
        data['days'][3]['rates']['GBP'] = 0
        with self.assertRaises(ValueError):
            forex.validate(data)


if __name__ == '__main__':
    unittest.main()
