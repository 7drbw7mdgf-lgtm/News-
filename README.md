# Daybreak

A news briefing across UK & world, science, tech and business. Each story shows coverage from several outlets, with each outlet's political leaning (ratings from Media Bias/Fact Check).

It's a plain static site: no build step, no server code.

```
index.html          page shell
assets/styles.css   styles
assets/app.js       rendering and interactions
assets/data.js      the stories, coverage and outlet ratings (window.DAYBREAK)
```

To preview locally, open `index.html` in a browser.

## Deploying to Fasthosts

Every push to `main` uploads the site to Fasthosts over FTPS using the workflow in `.github/workflows/deploy.yml`. You can also run it by hand from the **Actions** tab ("Deploy to Fasthosts" → "Run workflow").

### One-time setup

In the GitHub repo, go to **Settings → Secrets and variables → Actions**.

Under **Secrets**, add:

| Secret | What to put |
| --- | --- |
| `FTP_SERVER` | Your Fasthosts FTP host, e.g. `ftp.yourdomain.co.uk`, or the server IP shown in the Fasthosts control panel |
| `FTP_USERNAME` | Your FTP username from the Fasthosts control panel |
| `FTP_PASSWORD` | Your FTP password |

Optional, under **Variables**:

| Variable | Default | When to change it |
| --- | --- | --- |
| `FTP_SERVER_DIR` | `htdocs/` | If your site's web root is a different folder. Keep the trailing slash. |
| `FTP_PROTOCOL` | `ftps` | Override only if your hosting configuration requires a different TLS mode. |

The FTP details are only ever read from these secrets; they are not stored in the code.

### Notes

- The first deploy uploads everything. Later deploys upload only changed files (the action keeps a small `.ftp-deploy-sync-state.json` file on the server to track this).
- `README.md` and the `.github` folder are not uploaded.

## Updating the stories

The daily GitHub Actions workflow collects candidate articles from five RSS feeds at 06:15 UK time. Download its `daybreak-candidates` artifact and review the results. Identical normalised headlines are grouped automatically. The editor checks related headlines, verifies links, chooses the lead and writes source-linked comparisons where reporting meaningfully differs. Feed failures leave the current public edition available.

1. Copy the latest file in `editions/` to a new `YYYY-MM-DD.json` and update its edition metadata and stories. Keep each event’s existing ID when updating coverage, and use a new ID for a different event.
2. Run `node scripts/build-editions.mjs`. This checks story IDs, URL structure, coverage and comparison references and generates the current edition and archive in `assets/data.js`.
3. Commit the edition and the generated data together. Deployment validates the generated file before uploading.

Stories can be shared using `?story=EVENT-ID`. Keep old edition files so those links and bookmarks continue to resolve.
