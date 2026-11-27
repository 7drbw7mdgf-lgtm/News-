"""Fetch licensed Twelve Data quotes and FMP company fundamentals for Pheme.

This is a static-site publishing pipeline, NOT a low-latency live WebSocket service.
Never publish raw vendor quote data unless PHEME_MARKET_DATA_PUBLIC_DISPLAY=approved.
The API keys are read from GitHub Actions secrets and never written to artifacts.
"""
import datetime as dt
import json
import math
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "company-market-data.json"
COMPANIES = {
    "AAPL": "Apple", "MSFT": "Microsoft", "NVDA": "Nvidia",
    "TSLA": "Tesla", "GOOGL": "Alphabet", "AMZN": "Amazon",
}


def get_json(base_url, params):
    url = base_url + "?" + urlencode(params)
    request = Request(url, headers={"User-Agent": "PhemeMarketData/1.0", "Accept": "application/json"})
    with urlopen(request, timeout=18) as response:
        if response.status != 200:
            raise RuntimeError("Market provider HTTP response " + str(response.status))
        return json.load(response)


def numeric(value):
    try:
        number = float(value)
        return round(number, 4) if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


def get_twelve_data_quotes(secret):
    # Single batch quote request to conserve credits.
    response = get_json("https://api.twelvedata.com/quote", {
        "symbol": ",".join(COMPANIES), "apikey": secret,
    })
    if not isinstance(response, dict) or response.get("status") == "error":
        raise ValueError("Twelve Data returned an error or invalid payload")
    now = dt.datetime.now(dt.timezone.utc)
    quotes = {}
    for symbol, name in COMPANIES.items():
        q = response.get(symbol, {}) if len(COMPANIES) > 1 else response
        if not isinstance(q, dict) or q.get("status") == "error":
            continue
        price = numeric(q.get("close") or q.get("price"))
        if price is None or price <= 0:
            continue
        raw_time = q.get("datetime") or q.get("timestamp")
        quotes[symbol] = {
            "symbol": symbol, "name": name, "price": price,
            "changePercent": numeric(q.get("percent_change")),
            "currency": q.get("currency") or "USD",
            "quoteTime": str(raw_time)[:35] if raw_time is not None else None,
            "collectedAt": now.isoformat(timespec="seconds"),
            # Quote refreshes are snapshots, and could be delayed.
            "delay": q.get("is_market_open") is False and "market closed" or "unknown",
            "source": "Twelve Data",
        }
    return quotes


def get_twelve_data_history(secret, outputsize=260):
    """Daily closes for the price chart and technicals (one request per symbol)."""
    history = {}
    for symbol in COMPANIES:
        try:
            response = get_json("https://api.twelvedata.com/time_series", {
                "symbol": symbol, "interval": "1day", "outputsize": outputsize, "apikey": secret,
            })
            values = response.get("values") if isinstance(response, dict) and response.get("status") != "error" else None
            points = []
            for row in values or []:
                close = numeric(row.get("close"))
                date = str(row.get("datetime") or "")[:10]
                if close is not None and close > 0 and len(date) == 10:
                    points.append({"date": date, "close": close})
            points.sort(key=lambda p: p["date"])
            if len(points) >= 30:
                history[symbol] = points
        except (OSError, ValueError, KeyError, TypeError) as error:
            print("::warning::Twelve Data history for {} unavailable: {}".format(symbol, type(error).__name__))
    return history


def get_fmp_profiles(secret):
    profiles = {}
    for symbol in COMPANIES:
        try:
            result = get_json("https://financialmodelingprep.com/stable/profile", {
                "symbol": symbol, "apikey": secret,
            })
            p = result[0] if isinstance(result, list) and result else {}
            if not isinstance(p, dict) or p.get("symbol") != symbol:
                continue
            profiles[symbol] = {
                "company": COMPANIES[symbol],
                "sector": str(p.get("sector") or "")[:90],
                "industry": str(p.get("industry") or "")[:90],
                "exchange": str(p.get("exchangeShortName") or "")[:30],
                "marketCap": numeric(p.get("marketCap")),
                "beta": numeric(p.get("beta")),
                "lastDividend": numeric(p.get("lastDividend") or p.get("lastDiv")),
                "range52w": str(p.get("range") or "")[:40],
                "country": str(p.get("country") or "")[:60],
                "ceo": str(p.get("ceo") or "")[:90],
                "employees": numeric(p.get("fullTimeEmployees")),
                "website": str(p.get("website") or "")[:120] if str(p.get("website") or "").startswith("https://") else "",
                "description": str(p.get("description") or "")[:700],
                "source": "Financial Modeling Prep",
            }
        except (OSError, ValueError, KeyError, TypeError) as error:
            print("::warning::FMP profile for {} unavailable: {}".format(symbol, type(error).__name__))
    return profiles


def main():
    allowed = os.getenv("PHEME_MARKET_DATA_PUBLIC_DISPLAY") == "approved"
    twelve_key = os.getenv("TWELVE_DATA_API_KEY") or ""
    fmp_key = os.getenv("FMP_API_KEY") or ""
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    result = {
        "updatedAt": now,
        "status": "awaiting-licence" if not allowed else "awaiting-provider",
        "quoteType": "periodic-snapshot-not-live",
        "quoteDelay": "Not independently verified",
        "message": "Public display of vendor quotes requires appropriate licensing and API configuration.",
        "symbols": COMPANIES,
        "quotes": {},
        "history": {},
        "profiles": {},
    }
    if allowed:
        if twelve_key:
            try:
                result["quotes"] = get_twelve_data_quotes(twelve_key)
            except (OSError, ValueError, KeyError, TypeError) as error:
                print("::warning::Twelve Data not available: " + type(error).__name__)
            result["history"] = get_twelve_data_history(twelve_key)
        if fmp_key:
            result["profiles"] = get_fmp_profiles(fmp_key)
        if result["quotes"] or result["history"] or result["profiles"]:
            result["status"] = "available"
            result["message"] = "Licensed provider snapshots. Verify individual quote timestamps and exchange delays."
        else:
            result["message"] = "Provider data is not configured or currently unavailable."
    # Never keep previously published quotes if publication rights are disabled.
    # Avoid committing timestamps for unchanged disabled states.
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
            if result["status"] in ("awaiting-licence", "awaiting-provider"):
                result["updatedAt"] = previous.get("updatedAt", now)
        except (ValueError, OSError):
            pass
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Market provider integration: {}. Quotes: {}. Histories: {}. Profiles: {}.".format(
        result["status"], len(result["quotes"]), len(result["history"]), len(result["profiles"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
