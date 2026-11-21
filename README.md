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

Every push to `main` uploads the site to Fasthosts over FTP using the workflow in `.github/workflows/deploy.yml`. You can also run it by hand from the **Actions** tab ("Deploy to Fasthosts" → "Run workflow").

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
| `FTP_PROTOCOL` | `ftp` | Set to `ftps` if your plan supports FTP over TLS, so the password isn't sent in plain text. |

The FTP details are only ever read from these secrets; they are not stored in the code.

### Notes

- The first deploy uploads everything. Later deploys upload only changed files (the action keeps a small `.ftp-deploy-sync-state.json` file on the server to track this).
- `README.md` and the `.github` folder are not uploaded.

## Updating the stories

All content lives in `assets/data.js`. Replace that file with a new edition (same structure) and push; the site redeploys automatically.
