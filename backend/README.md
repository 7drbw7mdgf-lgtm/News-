# Pheme independent news-reader backend

The Railway service `pheme-reader-api` deploys from this repository using `backend/Dockerfile` and `railway.json`. It runs continuously, refreshing RSS feeds every 30 minutes by default and serving cached news metadata independently of Fasthosts.

- `GET /health`: process and cache freshness information
- `GET /v1/articles?limit=30`: recent cached articles (up to 100)
- `GET /v1/article?url=<encoded-original-publisher-url>`: cached lookup of a known publisher article

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
