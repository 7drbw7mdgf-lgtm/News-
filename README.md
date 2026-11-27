# Pheme

A news briefing across UK, world, science, tech, business and finance. Each story shows coverage from several outlets, with each outlet's political leaning (ratings from Media Bias/Fact Check).

Pheme serves a static frontend. GitHub Actions builds the site and refreshes the publisher-page cache before deployment; there is no persistent application server.

```
index.html          page shell
assets/styles.css   styles
assets/dashboard.css dashboard layout and responsive card styles
assets/app.js       rendering and interactions
assets/data.js      the stories, coverage and outlet ratings (window.DAYBREAK)
```

To preview locally, open `index.html` in a browser.

## Deploying to Fasthosts

Deployment works the same way as Sparkboard's. Every push to `main` runs `.github/workflows/deploy-website.yml`; you can also run it by hand from the **Actions** tab ("Deploy website to Fasthosts" → "Run workflow").

- **Connection:** explicit FTPS to `ftp.fasthosts.co.uk:21` as the FTP master user `pheme24.online`, with certificate checks and encrypted file transfers.
- **Destination:** the FTP login directory. If that directory turns out to contain an `htdocs` folder, the deploy stops without changing anything; set the repository variable `FTP_SERVER_DIR` to `htdocs` and re-run.
- **Safety:** each file is uploaded under a temporary name, read back and checked by SHA-256, then renamed into place. Nothing on the server is deleted. The previous homepage is backed up to `_daybreak/`, and `index.html` is published last.
- **Check:** after upload, the workflow confirms https://pheme24.online serves the new commit (via the `daybreak-build` meta tag). While DNS or the SSL certificate is still pending, this shows a warning rather than failing.

### One-time setup

1. In the repo: **Settings → Environments → New environment**, name it `fasthosts-production`. (Optionally restrict deployment branches to `main`.)
2. In that environment, add the secret `FASTHOSTS_FTP_PASSWORD`: the FTP master password for `pheme24.online`.

The password is only read from that secret; it is never in the code or logs.

## Updating the stories

The daily GitHub Actions workflow collects candidate articles from 35 RSS/Atom feeds across all six topics at 06:15 UK time. Download its `daybreak-candidates` artifact and review the results. Identical normalised headlines are grouped automatically. The editor checks related headlines, verifies links, chooses the lead and writes source-linked comparisons where reporting meaningfully differs. Feed failures leave the current public edition available.

1. Copy the latest file in `editions/` to a new `YYYY-MM-DD.json` and update its edition metadata and stories. Keep each event’s existing ID when updating coverage, and use a new ID for a different event.
2. Run `node scripts/build-editions.mjs`. This checks story IDs, URL structure, coverage and comparison references and generates the current edition and archive in `assets/data.js`.
3. Commit the edition and the generated data together. Deployment validates the generated file before uploading.

Stories can be shared using `?story=EVENT-ID`. Keep old edition files so those links and bookmarks continue to resolve.

Every view has its own address, so it can be bookmarked, shared, reloaded or opened in a new tab, and the browser's back and forward buttons move between views:

| Address | View |
| --- | --- |
| `/` | Home (all topics) |
| `?topic=uk` (`world`, `science`, `tech`, `business`, `finance`) | A topic desk; add `&q=…` for a search |
| `?view=newspapers` | Newspaper directory |
| `?publisher=NAME` | One newspaper |
| `?view=saved` | Saved stories |
| `?view=trading` | Trading; add `&workspace=TAB` for a tab (e.g. `news`, `calendar`, `octal`) and `&company=SYMBOL` on the company tab |
| `?story=EVENT-ID` | A story |

`render()` in `assets/app.js` keeps the address in step with what is on screen. The page title follows the view too. The older `?workspace=octal` links still work.

## Header and native reader

The dashboard includes a responsive sidebar, followed-newspaper tiles, compact headlines and image cards. Existing local topic illustrations are used when a story has no image and are labelled “Topic image”. All current stories remain available through the dashboard, topic filters and search.

Digest, coverage methodology and followed newspapers are available from header dropdowns. Settings saves the clock and market choices in this browser alongside existing reader preferences and bookmarks.

The market strip uses native SVG sparklines for the FTSE 100, S&P 500 and Shanghai Composite. Selecting a card opens an accessible Pheme chart dialog with 1M, 3M, 6M and 1Y ranges, pointer exploration and keyboard navigation. Each value is a completed daily close, with its session date displayed. The popup identifies Yahoo Finance as the data source. These are daily index values, rather than a live feed or index CFDs.

`scripts/update-markets.py` fetches and validates public historical quotes, excludes the current incomplete trading day, and keeps the last valid series if an individual refresh fails. `.github/workflows/markets.yml` checks every six hours and publishes changed data through the existing Fasthosts deployment. The deployment also validates the checked-in dataset offline.

Headlines, comparison citations and coverage links open Pheme’s native reader. An outlet selection can be shared using `?story=EVENT-ID&source=OUTLET-NAME`. Publisher article links use the native reader to show the publisher page when it can be extracted, while Pheme’s own briefing remains clearly identified as Pheme’s work.

### Publisher pages in the native reader

The deployment workflow runs `scripts/scrape-indian-express.mjs` on GitHub Actions at deploy time and every six hours. It reads only Indian Express article URLs already present in the current `assets/data.js` edition, fetches public pages without login cookies, limits each response to 8 MiB and follows up to three HTTPS redirects on the same host. Successful pages are deployed as same-origin JSON assets; Mozilla Readability extracts the page in the browser and Pheme sanitizes the result before rendering it. The scraper does not bypass subscriber restrictions. If a page is denied or unavailable, Pheme shows the available RSS excerpt and publisher link.

## Article content

Pheme articles describe the events themselves. Outlet counts, political leaning and reader instructions belong to the coverage interface and are rejected as article bodies. The current edition has source-based original articles in `articles/2026-11-22.json`, with source references and update dates; `scripts/apply-article-edits.py` applies them before regenerating `assets/data.js`.

The scheduled GitHub Actions writer runs Qwen3-4B on the runner and needs no API key. It checks proposed sentences against their cited publisher excerpts with a local entailment model, filters extended verbatim passages, and requires two linked outlets and at least 80 words per article. These automated checks can miss factual errors. Every six hours the job aims for 12 stories across the desks and publishes when at least eight qualify. A failed build keeps the last edition available. When newer publisher reports arrive on a later date, the homepage displays their dated links above the edition. The hosted writer can still be run manually with `ANTHROPIC_API_KEY` or `GROQ_API_KEY`. Older archived entries without an article are labelled as unavailable in the reader rather than expanded into generic text.

## Principia Phemica input feed

The Fasthosts build publishes a versioned JSON input at
[api/phemica/v1/input.json](https://pheme24.online/api/phemica/v1/input.json).
The collector and verified plan records serve two different inputs.

- **articles** are publisher metadata for claim extraction. Each article has
  an ID based on its canonical URL and a version ID based on its source text
  and metadata. **observedAt** records the reader snapshot time. Consumers
  should retain observations by version ID to establish first-seen times
  within their own archive. **publishedAt** carries the publisher's timestamp
  where one with a UTC offset is available. **originId** stays null until
  claim-level attribution is verified. Editorial summaries, archive references
  without publisher metadata and article bodies are excluded.
- **planEvents** are verified operator-backed assertions. Add a new event
  to feeds/phemica-plan-events.json and point **supersedes** to the preceding
  record for the same company, site and process. Use **publicAvailableOn**
  for the dated source's publication day. **effectiveOn** records an exact
  operational date where given and **effectiveBy** can preserve a deadline
  without inventing a day of execution. Use null for unknown dates. Subsequent
  postponements and confirmations can change the current plan status while
  preserving the original announcement. The initial records reproduce the
  Bremen 2022 replay. RSS candidates do not update this ledger automatically.

The input feed is a snapshot. Run a consumer on a cadence suitable for the
pilot and archive each observed article version, since rolling reader entries
may disappear between polls. Date-only plan events support end-of-day replay.
Exploring intraday timing requires source timestamps and a consumer audit log.

To validate or replay a downloaded input:

```sh
python3 -m unittest discover -s scripts -p 'test_phemica_input.py'
python3 -c 'import json; from backend.phemica_input import plans_as_of; print(plans_as_of(json.load(open("input.json")), "2022-09-30"))'
```
