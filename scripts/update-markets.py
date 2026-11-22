"""Collect completed daily index candles for Pheme's native charts."""
import argparse
import concurrent.futures
import datetime as dt
import json
import math
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'markets.json'
MARKETS = {
    'london': ('^FTSE', 'Europe/London'),
    'newyork': ('^GSPC', 'America/New_York'),
    'shanghai': ('000001.SS', 'Asia/Shanghai'),
}


def validate_market(market):
    points = market.get('points', [])
    if len(points) < 30:
        raise ValueError('Expected at least 30 daily closes')
    previous = ''
    for point in points:
        date = dt.date.fromisoformat(point['date']).isoformat()
        value = point['close']
        if date <= previous or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('Invalid or unordered market candle')
        previous = date
    if market.get('asOf') != points[-1]['date']:
        raise ValueError('Market date does not match its latest candle')
    return market


def collect(market_id):
    symbol, zone_name = MARKETS[market_id]
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + quote(symbol, safe='') + '?range=1y&interval=1d'
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0 Pheme/1.0', 'Accept': 'application/json'})
    with urlopen(request, timeout=30) as response:
        data = json.load(response)
    result = data['chart']['result'][0]
    zone = ZoneInfo(zone_name)
    today = dt.datetime.now(zone).date()
    points = {}
    closes = result['indicators']['quote'][0]['close']
    for timestamp, close in zip(result['timestamp'], closes):
        date = dt.datetime.fromtimestamp(timestamp, zone).date()
        # Today's candle may still be forming. Publish completed days only.
        if date < today and isinstance(close, (int, float)) and math.isfinite(close) and close > 0:
            points[date.isoformat()] = round(close, 4)
    series = [{'date': date, 'close': points[date]} for date in sorted(points)]
    market = {'symbol': symbol, 'asOf': series[-1]['date'] if series else None, 'points': series}
    return validate_market(market)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Validate the checked-in data without network access')
    args = parser.parse_args()
    existing = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {'markets': {}}
    if args.check:
        for market_id in MARKETS:
            validate_market(existing['markets'][market_id])
        print('Validated daily data for all three native market charts.')
        return
    markets = dict(existing.get('markets', {}))
    fresh = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {market_id: pool.submit(collect, market_id) for market_id in MARKETS}
        for market_id, job in jobs.items():
            try:
                markets[market_id] = job.result()
                fresh += 1
                print(market_id + ': ' + str(len(markets[market_id]['points'])) + ' daily closes through ' + markets[market_id]['asOf'])
            except Exception as error:
                print('::warning::Could not refresh ' + market_id + ' (' + type(error).__name__ + '); retaining its last verified data.')
    if not fresh:
        raise SystemExit('No market data refreshed; leaving the published data unchanged.')
    for market_id in MARKETS:
        validate_market(markets[market_id])
    # Unchanged market sessions do not need another commit or FTP deployment.
    if markets == existing.get('markets'):
        print('Daily market data is unchanged.')
        return
    payload = {'updatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'source': 'Yahoo Finance', 'markets': markets}
    temporary = OUTPUT.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(OUTPUT)


if __name__ == '__main__':
    main()
