# Pheme Market Provider Setup

Pheme is published as a static site to Fasthosts. GitHub Actions collects hourly
snapshots from vendor APIs, so **this is not a real-time trading WebSocket**.

## Provider credentials

1. Sign up for Twelve Data and optionally Financial Modeling Prep (FMP).
2. Confirm that your contract explicitly permits **redistribution / public website display**
   of the requested symbols and exchange data. A standard individual API key alone
   does **not** grant public redistribution rights.
3. In GitHub repository Settings > Secrets and variables > Actions > Secrets, set:
   - `TWELVE_DATA_API_KEY` (Twelve Data REST API key)
   - `FMP_API_KEY` (optional, company profile enrichment only)
4. **Only when the public display licence is confirmed**, add a GitHub Actions
   repository variable `PHEME_MARKET_DATA_PUBLIC_DISPLAY` with value `approved`.
5. The collector then also fetches about a year of daily closes per symbol
   (`history`), which powers the Company tab's price chart and technicals.
   Each symbol costs one extra Twelve Data request per run.
6. Trigger `Refresh Pheme market charts` with workflow_dispatch, check its logs,
   and confirm the deployed `assets/company-market-data.json` has status
   `available`. If no quote is supplied, no quote appears in the UI.
7. Confirm the latest `Deploy website to Fasthosts` workflow passed verification.

## Privacy, caching and claims

- Vendor keys remain in GitHub Actions secrets. Never put them in HTML, CSS,
  client-side JS or committed configuration files.
- REST quote batches are collected **hourly**; the front end rechecks the published
  JSON every five minutes. More frequent browser requests cannot make the
  underlying feed real-time.
- Quote labels report source timestamps and stale snapshots. They do not assert
  exchange-level live, consolidated, or real-time quality.
- Existing index charts continue using **completed daily closes** from the
  separate market collection pipeline.
- Twelve Data's licence conditions and FMP's display/redistribution terms must
  be checked for the actual account, purpose, region and exchange.
- If the licence flag is absent, the collector publishes no quote prices.
- For genuine continuous streaming, use a server-side WebSocket gateway on an
  appropriate host and obtain the necessary exchange/data-provider agreements;
  a public static Fasthosts deployment cannot safely connect directly using
  a private vendor WebSocket API key.
