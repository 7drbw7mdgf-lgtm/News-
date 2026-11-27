"""Collect ECB euro foreign exchange reference rates for Pheme's native FX widgets.

Source: European Central Bank, euro foreign exchange reference rates
(https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/).
The ECB publishes these for information; reuse is permitted with the source cited.
They are set once per TARGET working day at around 16:00 CET, so they are daily
reference rates, not live dealing prices.

Usage:
  python3 scripts/update-forex.py            fetch, validate and write assets/forex.json
  python3 scripts/update-forex.py --check    validate the committed file (offline)
"""
import argparse
import datetime as dt
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'forex.json'
SOURCE_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
PAGE_URL = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'
# EUR is the base; these are the currencies Pheme shows (EUR is implied as 1).
CURRENCIES = ['GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'INR', 'CNY']
MIN_DAYS = 20


def parse_ecb(xml_bytes):
    """Return ascending [{date, rates}] from ECB eurofxref XML."""
    root = ET.fromstring(xml_bytes)
    days = []
    for cube in root.iter():
        if not cube.tag.endswith('Cube') or 'time' not in cube.attrib:
            continue
        date = dt.date.fromisoformat(cube.attrib['time']).isoformat()
        rates = {}
        for child in cube:
            code = child.attrib.get('currency')
            if code in CURRENCIES:
                rates[code] = float(child.attrib['rate'])
        if all(code in rates for code in CURRENCIES):
            days.append({'date': date, 'rates': rates})
    days.sort(key=lambda d: d['date'])
    return days


def validate(data):
    if data.get('base') != 'EUR' or data.get('currencies') != CURRENCIES:
        raise ValueError('Unexpected forex base or currency list')
    days = data.get('days')
    if not isinstance(days, list) or len(days) < MIN_DAYS:
        raise ValueError('Expected at least %d daily reference rates' % MIN_DAYS)
    previous = ''
    for day in days:
        date = dt.date.fromisoformat(day['date']).isoformat()
        if date <= previous:
            raise ValueError('Forex dates are not strictly ascending')
        previous = date
        for code in CURRENCIES:
            value = day['rates'].get(code)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError('Invalid %s rate on %s' % (code, date))
    if data.get('asOf') != days[-1]['date']:
        raise ValueError('Forex asOf does not match the latest rate date')
    return data


def build(xml_bytes, now=None):
    days = parse_ecb(xml_bytes)
    now = now or dt.datetime.now(dt.timezone.utc)
    data = {
        'updatedAt': now.isoformat(timespec='seconds'),
        'source': 'European Central Bank',
        'sourceUrl': PAGE_URL,
        'note': 'Euro foreign exchange reference rates, set once per TARGET working day around 16:00 CET. Not live dealing prices.',
        'base': 'EUR',
        'currencies': CURRENCIES,
        'asOf': days[-1]['date'] if days else None,
        'days': days,
    }
    return validate(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='validate the committed file without network access')
    args = parser.parse_args()
    if args.check:
        if not OUTPUT.exists():
            print('No forex.json yet; the markets workflow creates it.')
            return 0
        validate(json.loads(OUTPUT.read_text(encoding='utf-8')))
        print('Forex reference rates valid.')
        return 0
    request = Request(SOURCE_URL, headers={'User-Agent': 'PhemeMarkets/1.0 (+https://pheme24.online)'})
    try:
        with urlopen(request, timeout=25) as response:
            data = build(response.read())
    except (OSError, ValueError, ET.ParseError) as error:
        # Keep the last good file; a failed refresh must not blank the page.
        print('::warning::ECB reference rates unavailable: ' + type(error).__name__)
        return 0
    if OUTPUT.exists():
        previous = json.loads(OUTPUT.read_text(encoding='utf-8'))
        if previous.get('days') == data['days']:
            print('Forex reference rates unchanged.')
            return 0
    OUTPUT.write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')
    print('Wrote %d days of ECB reference rates to %s (latest %s).' % (len(data['days']), OUTPUT.name, data['asOf']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
