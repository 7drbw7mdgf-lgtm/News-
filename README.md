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

All content lives in `assets/data.js`. Replace that file with a new edition (same structure) and push; the site redeploys automatically.
