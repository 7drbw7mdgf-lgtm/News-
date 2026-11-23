# Pheme independent news-reader backend

The Railway service `pheme-reader-api` deploys from this repository using `backend/Dockerfile` and `railway.json`. It runs continuously, refreshing RSS feeds every 30 minutes by default and serving cached news metadata independently of Fasthosts.

- `GET /health`: process and cache freshness information
- `GET /v1/articles?limit=30`: recent cached articles (up to 100)
- `GET /v1/article?url=<encoded-original-publisher-url>`: cached lookup of a known publisher article
- `GET /v1/corroborate?url=<encoded-original-publisher-url>`: first-pass Pheme-8 economic proposition matching, supporting and contradicting publishers, and provisional octal corroboration level

Production endpoint: https://pheme-reader-api-production.up.railway.app

The frontend calls the Railway article lookup when an article is opened. It falls back to the last static RSS cache if Railway is unavailable. The backend retrieves public RSS entries, archived editorial source references and limited metadata where robots.txt permits. Full text is restricted to publishers expressly approved in `feeds/reader-permissions.json`; that list is initially empty.

## Storage and deployment

The worker keeps a last-good cache under `/tmp/pheme-reader`; this is **ephemeral** and will be lost during a restart. The worker will repopulate it by reading publisher feeds. This is not a substitute for durable storage.

A dedicated Supabase database is provisioned in project `odwrnxdmjypeewgwkotc` with `pheme_articles` and `pheme_scrape_runs` tables. Public read access uses row-level security and public writes are not allowed.

A dedicated Supabase Edge Function named `pheme-ingest` is deployed for secure article ingestion:

`https://odwrnxdmjypeewgwkotc.supabase.co/functions/v1/pheme-ingest`

**The Supabase ingestion connection is not activated yet.** It requires `PHEME_INGEST_TOKEN` to be set as a Supabase Edge Function secret and the *same* token on Railway as `PHEME_SUPABASE_INGEST_TOKEN`, together with `PHEME_SUPABASE_INGEST_URL` pointing to the function URL. Generate a fresh high-entropy random token and configure it in both platforms via their secure variables/secrets dashboards. Do not put secrets in GitHub, in browser assets or in the documentation. Without that configuration, the worker serves its local cache and explicitly logs that Supabase push is not configured.

## Environment configuration

- `PORT` – Railway-provided bind port; defaults to 8080
- `PHEME_REFRESH_SECONDS` – RSS update cadence; defaults to 1800 (minimum 900)
- `PHEME_MAX_FEEDS` – number of feeds checked per pass; defaults to 48
- `PHEME_CACHE_DIR` – optional writeable cache directory, defaults to `/tmp/pheme-reader`
- `PHEME_SUPABASE_INGEST_URL` – optional secure ingestion function URL
- `PHEME_SUPABASE_INGEST_TOKEN` – optional shared token for ingestion; never public

The existing Fasthosts site and deployment workflow remain separate. Railway uptime and usage depend on the account billing plan; a successful deployment does not guarantee a permanently free service.

## Pheme-8 source corroboration (prototype)

The `backend/corroboration.py` module scans source-attributed RSS titles and descriptions in the existing cache. It detects explicit macroeconomic and earnings-event phrases, requires a recognizable entity, compares only the *same entity and event*, and keeps links to original articles. The independent source count uses publisher identity as a weak proxy and excludes copied identical headlines, speculative/denied statements and records with missing or stale publication times. Pheme's own editorial summaries are **never** counted as publisher evidence.

When there are zero qualifying external reports, the result remains **unverified**, not `0₈` or false. One independent supporting publisher produces provisional `4₈`, two produce `5₈`, and three or more produce `6₈`. Contradicting publications produce `contested` with no numeric grade. These are strictly *corroboration coverage levels*, not evidence that the event occurred, publisher truthfulness, market-move probability or investment advice. `7₈` is deliberately not assigned without primary-source verification, which this prototype does not implement. Related reporting can share a wire, ownership or original source even with different headlines. The rule-based extractor is incomplete and should be replaced or reviewed against annotated articles before using for any real-world decision. No trading or broker API is connected.
