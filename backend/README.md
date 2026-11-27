# Pheme independent news-reader backend

The Railway service `pheme-reader-api` deploys from this repository using `backend/Dockerfile` and `railway.json`. It runs continuously, refreshing RSS feeds every 30 minutes by default and serving cached news metadata independently of Fasthosts.

- `GET /health`: process and cache freshness information
- `GET /v1/articles?limit=30`: recent cached articles (up to 100)
- `GET /v1/article?url=<encoded-original-publisher-url>`: cached lookup of a known publisher article
- `GET /v1/corroborate?url=<encoded-original-publisher-url>`: first-pass Pheme-8 economic proposition matching, supporting and contradicting publishers, and provisional octal corroboration level
- `GET /v1/infer?url=<encoded-original-publisher-url>`: Pheme-8 octal inference with full operation trace and no trading execution
- `GET /v1/primary-costs?industry=ai_infrastructure`: reusable Primary Costs taxonomy, industry-relevance candidates and known overlaps
- `GET /v1/resource-graph`: read-only, typed, validated example production network with node/edge schema
- `GET /v1/resource-evidence`: source-backed recent resource-headline matches, directional corroboration candidates and explicit uncertainty
- `GET /v1/resource-scenario?shock=gas&percent=20`: read-only hypothetical scenario across the demonstration graph; never a forecast

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

The `backend/corroboration.py` module scans source-attributed RSS titles and descriptions in the existing cache. It detects explicit macroeconomic and earnings-event phrases, requires a recognizable entity, compares only the *same entity and event*, and keeps links to original articles. Each claim is keyed to the entity nearest its own wording, not the article's first entity: rate decisions are normalised to the central bank (so "UK cuts rates" matches "BoE cuts rates") and inflation to the economy. "US" is matched only in capitals, so the pronoun "us" is ignored. Earnings claims require a company named directly before the claim that appears in `assets/companies.json`, so different companies never corroborate each other; unknown companies produce no claim. The independent source count uses publisher identity as a weak proxy and excludes copies of the target's own headline (whichever is newer), other copied identical headlines, speculative/denied statements and records with missing or stale publication times. Pheme's own editorial summaries are **never** counted as publisher evidence.

When there are zero qualifying external reports, the result remains **unverified**, not `0₈` or false. One independent supporting publisher produces provisional `4₈`, two produce `5₈`, and three or more produce `6₈`. Contradicting publications produce `contested` with no numeric grade. These are strictly *corroboration coverage levels*, not evidence that the event occurred, publisher truthfulness, market-move probability or investment advice. `7₈` is deliberately not assigned without primary-source verification, which this prototype does not implement. Related reporting can share a wire, ownership or original source even with different headlines. The rule-based extractor is incomplete and should be replaced or reviewed against annotated articles before using for any real-world decision. No trading or broker API is connected.

## Pheme-8 multiplication and evidence filtering (Element 2, v2)

`backend/octal_engine.py` now uses **octal multiplication**, not Boolean, NAND, AND, OR, NOT, or implication gates. Each input carries a discrete strength `0..7`, or `None` for unavailable evidence. Mathematically the normalized combination of `n` corroboration values is:

```text
raw = round_half_up(7 × ∏(value_i / 7))
    = round_half_up(∏(value_i) / 7^(n-1))
```

The engine calculates the *whole* product as an exact integer rational before rounding once. Quantizing after every pair would introduce rounding-order dependence. For example `6₈ × 5₈ × 4₈ = round(120/49) = 2₈`, whereas `7₈ × 7₈ = 7₈`. These represent **coverage strength under a chosen aggregation rule**, not independent probabilities.

The default pipeline is:

1. **Input filter:** each proposition must have fresh, corroborated evidence, no contradiction, and a source corroboration grade of at least `4₈`. Unknown and unverified evidence remain distinct from numeric `0₈`. All required premises must pass.
2. **MULTIPLY8:** multiply normalized strengths without arbitrary operator gates. Return a numeric result and exact fraction in the trace.
3. **Output filter:** only expose the resulting score as `octalResult` when it reaches `4₈`. Otherwise report `status=filtered` and include `rawOctalResult` for audit. Do not silently omit weak premises.
4. **Execution:** always disabled; no broker orders or trading recommendations.

The process returns the complete input assessment, filter reasons, multiplication trace and threshold. The default thresholds can be configured via the pure-Python function arguments and are **not externally user-adjustable in the live API** in this version.

`GET /v1/infer?url=<publisher-article-url>` wraps this process using `/v1/corroborate` inputs. The upstream RSS/keyword matching and publisher independence checks remain prototypes, so the result is not an established source-reliability score, truth probability or indication of asset direction.

Regression tests: `python3 -m unittest discover -s scripts -p 'test_octal_engine.py'`.

## Pheme-8 Primary Costs (Element 3)

The `backend/primary_costs.py` module defines **18 cost classes**, nine sector templates, and explicit known dependency pairs. The categories include power/fuel, materials, chips, industrial equipment, wages, construction, transport, import duties, property, debt financing, compliance, cloud/network, maintenance, tax, supplier scarcity, water, insurance and sales acquisition. These are candidate direct/indirect financial cost drivers; the relevance of a driver to any specific company must be established independently.

`GET /v1/primary-costs?industry=ai_infrastructure` returns a read-only taxonomy and dependency warnings. Available profiles: `ai_infrastructure`, `software_ai`, `semiconductors`, `manufacturing`, `retail`, `airlines`, `utilities`, `mining` and `healthcare`. Omitting `industry` lists the full cost registry.

The pure `aggregate(industry, evidence, floor=4)` function accepts *previously corroborated structured proposition evidence*, not unverified keywords, and evaluates each relevant branch using normalized octal multiplication after filtering. Any missing, unsupported or contradicted required premise leaves that branch unscored. It returns separate branch scores, provenance, traces and overlap warnings, with `combinedScore=null` and `execution=disabled`. It does **not** multiply all costs into one global score: tariffs may already be embedded in GPU prices, labour in construction, and fuel in transport, so global aggregation requires real accounting exposure data and deduplication.

**Current integration boundary:** the taxonomic REST route exists, but news-to-cost classification, company-specific exposures, a visual website dashboard and broker execution are **not implemented**. Adding a category does not assert that Pheme's present RSS corpus contains relevant claims for it. The `aggregate` function can already be tested with validated structured inputs; exposing it publicly would require a reviewed input validator and issuer mapping.

Run: `python3 -m unittest discover -s scripts -p 'test_primary_costs.py'`.

## Stage 3: typed resource production graph

The pure-Python `backend/resource_graph.py` models five node types: **primary**, **secondary**, **process**, **company**, and **financial**. Four typed directed relations are supported: `requires`, `produces`, `supplies`, and `affects_cost`. The validator enforces permissible source/target types, unique IDs, no self-loops or duplicate directed edges, and acyclic graphs. Any optional quantitative edge requires a positive number and an explicit unit, but this stage does **not** estimate a causal coefficient or propagate costs.

The AI infrastructure demonstration is illustrative and should not be represented as a verified company's actual production network. The endpoint `/v1/resource-graph` exposes a schema and the seed example; browser users can edit a separate client-local copy in **Trading → Resource network** on both desktop and mobile. It provides a horizontally scrollable SVG, node inspector, type editing, add/delete nodes, validated links, reset, and JSON export. Drafts save to browser localStorage only: no account sync, import of arbitrary JSON, persistence to Supabase, or public server mutation exists.

Economic exposure measurement, scenario propagation, correlation-aware cost aggregation, evidence linkage and trade execution are **not implemented in this graph editor**. Tests: `python3 -m unittest discover -s scripts -p 'test_resource_graph.py'`.

## Stage 4: connecting publisher reporting to resource nodes

The `backend/resource_evidence.py` extractor scans **publisher-authored RSS headlines** for explicit seed-resource mentions and directional language. It excludes Pheme-authored editorial summaries, stale/undated articles, and qualified/negated wording as corroborating evidence. Two distinct named publishers with directionally similar *nonidentical* reports produce an illustrative `4₈` corroboration coverage level; three produce `5₈`; four or more `6₈`. Contradictions produce `contested` with a null score. Missing sources are unknown, never `0₈`.

**This only links candidate news to resource nodes.** A publisher agreement is not proof; a word match is not a validated economic proposition; source feeds may share wire stories, owners, or primary evidence. News about a gas price rise does **not** verify that the gas→power-production relationship holds for any specified supplier or company. None of these resources has a measured issuer-specific price exposure or demonstrated trading signal.

`GET /v1/resource-evidence` returns all seed-node candidates; passing `?node=gas` restricts to gas. The graph inspector in **Trading → Resource network** fetches this read-only service and displays links to original publisher reports, timestamps, direction and conditional octal corroboration. Custom nodes lack an approved extractor and remain explicitly unsupported. Evidence results are cached for five minutes in the browser and refreshed manually or when revisiting after expiration. On API failure the resource editor continues to function without claiming confirmed evidence.

No broker orders, causal edge verification, numeric cost propagation or inferred security returns are implemented here.

Tests: `python3 -m unittest discover -s scripts -p 'test_resource_evidence.py'`.

## Stage 5: quantitative shock scenarios (illustrative)

`backend/resource_scenario.py` introduces a separate economic-assumption layer. An edge may have an optional `passThrough` coefficient from 0 to 1, specifying a *hypothetical relative-percent sensitivity of the target's metric to the source's metric*. A resource-price shock of `s` percent travels across one edge as `s × passThrough`; multi-step effects multiply coefficients, **not octal evidence scores**. The example assigns four **invented, explicitly demonstrative** coefficients to a gas → power generation → electricity → AI data centre → operating-margin path, without claiming they are estimated economic facts.

The engine validates acyclic typed graph structure, finite shock bounds (-100% to +100%), and finite coefficient bounds. A missing coefficient yields an unknown/unreached result, not a numeric zero. If a resource reaches the same downstream node along multiple paths, the engine flags `overlap-review-required`, produces no change estimate for that node and propagates the review requirement downstream rather than double-counting pathways. All calculations are hypothetical relative changes, not prices, cash-flow forecasts or security valuations.

The front-end resource editor provides a **Cost shock simulator**, user-editable coefficients in the node inspector, and a scenario output table. Edits remain in browser storage, and the demo graph can be reset to the annotated default assumptions. The public backend offers `/v1/resource-scenario?shock=gas&percent=20` for the fixed demonstrative graph only; it does not accept or persist arbitrary client graphs.

This stage **does not** connect empirical price series, unit-consistent cost-accounting parameters, audited issuer exposures, sensitivity estimation, source evidence gates or investor returns. The coefficient on a financial outcome is purely illustrative, not a real operating-margin elasticity. Evidence strength from Pheme-8 Stage 4 never becomes an economic coefficient. Trade execution remains disabled. Run `python3 -m unittest discover -s scripts -p 'test_resource_scenario.py'`.

## Private Trading 212 widget

Trading → Evidence Bot embeds the widget from the Railway reader origin. The
iframe is isolated from the site's market widgets. The account endpoint accepts
a PHEME widget access token and serves account value, available cash and open
positions over HTTPS. It uses only the broker's account-summary and positions
GET endpoints. Responses omit account IDs and use no-store.

Configure these private Railway service variables:

- **TRADING212_API_KEY** and **TRADING212_API_SECRET** from a Trading 212 API key
  with read-only account and positions access. Start with a demo account.
- **TRADING212_ENV** is demo by default. Set live only for a live read-only key.
- **PHEME_TRADING212_WIDGET_TOKEN** is a separate random 64-character lowercase
  hex token. Generate it with openssl rand -hex 32 and keep it with the account
  operator. Enter this token, rather than the brokerage credentials, to unlock
  the widget. Rotating it revokes use of the old token on subsequent requests.

Each Railway instance exposes a single configured private account to holders
of that token. The read-only configuration requires no order permissions.

### Optional demo orders

Set **PHEME_TRADING212_DEMO_ORDERS=true** alongside **TRADING212_ENV=demo**.
Create a demo API key with account and positions read permissions plus
`orders:read` and `orders:execute`. Leave the flag unset for read-only access.
The server sends orders only to the demo host. Live accounts remain read-only.

The widget accepts manual market buys and sells with extended hours disabled
and cancellation requests for pending orders. It displays the order for
review before requiring a second click. A preview expires after 90 seconds
and can be consumed once. A restart invalidates previews, so the demo ordering
service should run as a single instance. Pending order results may be cached
for up to 10 seconds. If submission times out or the result is unknown, verify
the order status in Trading 212 before submitting again. The widget never
retries a brokerage write automatically.

Official setup is at https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key.
