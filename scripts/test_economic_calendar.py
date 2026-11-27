import copy
import datetime as dt
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('check_calendar', Path(__file__).with_name('check-economic-calendar.py'))
calendar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calendar)
DATA = json.loads(calendar.PATH.read_text(encoding='utf-8'))


class EconomicCalendarTest(unittest.TestCase):
    def test_committed_calendar_is_valid(self):
        self.assertEqual(calendar.validate(DATA, dt.date(2026, 11, 27)), [])

    def test_every_event_links_to_an_official_source(self):
        bad = copy.deepcopy(DATA)
        bad['events'][0]['sourceUrl'] = 'https://example-forex-blog.com/calendar'
        with self.assertRaises(ValueError):
            calendar.validate(bad)

    def test_warns_when_the_calendar_runs_out(self):
        self.assertTrue(calendar.validate(DATA, dt.date(2027, 7, 1)))

    def test_rejects_unordered_events(self):
        bad = copy.deepcopy(DATA)
        bad['events'].reverse()
        with self.assertRaises(ValueError):
            calendar.validate(bad)


if __name__ == '__main__':
    unittest.main()
