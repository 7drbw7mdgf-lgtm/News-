"""Validate assets/economic-calendar.json and warn when it needs topping up.

Every event must come from the issuing central bank or statistics office and link
to it. The calendar is maintained by hand from those official schedules, so this
check flags (as a GitHub Actions warning, not a failure) when few future events
remain.
"""
import datetime as dt
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'assets' / 'economic-calendar.json'
TYPES = {'central-bank', 'data'}
OFFICIAL_HOSTS = ('federalreserve.gov', 'bankofengland.co.uk', 'ecb.europa.eu', 'boj.or.jp',
                  'rbi.org.in', 'bls.gov', 'ons.gov.uk', 'gov.uk', 'stats.gov.cn', 'mospi.gov.in',
                  'ec.europa.eu', 'bea.gov', 'stat.go.jp')


def validate(data, today=None):
    today = today or dt.date.today()
    regions = data.get('regions') or {}
    events = data.get('events')
    if not isinstance(events, list) or not events:
        raise ValueError('Calendar has no events')
    previous = ''
    for event in events:
        date = dt.date.fromisoformat(event['date']).isoformat()
        if date < previous:
            raise ValueError('Events are not in date order')
        previous = date
        if event.get('region') not in regions:
            raise ValueError('Unknown region ' + str(event.get('region')))
        if event.get('type') not in TYPES:
            raise ValueError('Unknown event type ' + str(event.get('type')))
        if not str(event.get('title', '')).strip() or not str(event.get('source', '')).strip():
            raise ValueError('Event needs a title and source')
        host = urlparse(event.get('sourceUrl', '')).hostname or ''
        if urlparse(event['sourceUrl']).scheme != 'https' or not any(host == h or host.endswith('.' + h) for h in OFFICIAL_HOSTS):
            raise ValueError('Source must be an official https page: ' + event.get('sourceUrl', ''))
        if 'time' in event and (not re.fullmatch(r'\d{2}:\d{2}', event['time']) or not event.get('timezone')):
            raise ValueError('Times need HH:MM and a timezone')
    upcoming = [e for e in events if e['date'] >= today.isoformat()]
    warnings = []
    if len([e for e in upcoming if e['date'] <= (today + dt.timedelta(days=60)).isoformat()]) < 4:
        warnings.append('Fewer than four calendar events in the next 60 days; add newly published official dates.')
    if not upcoming or upcoming[-1]['date'] < (today + dt.timedelta(days=60)).isoformat():
        warnings.append('The economic calendar runs out within 60 days; add newly published official dates.')
    return warnings


def main():
    data = json.loads(PATH.read_text(encoding='utf-8'))
    for warning in validate(data):
        print('::warning::' + warning)
    print('Economic calendar valid: %d events.' % len(data['events']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
