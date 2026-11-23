# Server-side publisher reader

The reader is generated during Fasthosts deployment by `scripts/build-publisher-reader.py`. It consumes the publisher's collected RSS feed, writes `build/site/assets/reader-cache/index.json`, and lets the Pheme reader display the latest available headline, attribution, publication time, image and RSS excerpt from a first-party cache. User browsers no longer need to fetch publisher HTML for this preview.

## Recovering inaccessible articles

The build now combines the current publisher RSS feed with source links retained in the current **and archived** Pheme editorial editions. An article that has disappeared from RSS still gets a source-reference card, showing the publisher-specific title when known and preserving its original URL.

For older links without sufficient RSS metadata, the build makes a small number of server-side requests to retrieve **public Open Graph/title/description metadata only**. It first checks publisher robots.txt, does not follow redirects, limits response size and skips inaccessible sources. It never copies the publisher's full article as part of this recovery path. Pheme's own summary is displayed only as clearly labelled editorial context, never attributed to the original publisher.

A recovered item is identified as one of `rss`, `edition-reference`, `publisher-metadata`, or `licensed-full-text` in the reader cache. Metadata recovery is best-effort; publishers can block automated access and unavailable articles remain linked to their original location.

## Full article extraction (authorised publishers only)

Full text is **disabled by default**. To enable it for a specific publisher, first verify that automated collection **and public republication** are permitted under a licence or the publisher's explicit terms, then add an entry to `feeds/reader-permissions.json`:

```json
{
  "version": 1,
  "authorisedPublishers": [
    {
      "publisher": "Publisher Name",
      "host": "news.example.org",
      "permissionConfirmed": true
    }
  ]
}
```

The publisher name must match an existing feed. The host must match exactly. Do **not** add any publisher without rights to republish the entire article. The extractor refuses unknown robots.txt policies, private destinations, non-HTTPS URLs, redirects and large responses, and skips inaccessible pages. No paywall bypass or anti-bot evasion is implemented. The built-in simple article parser may need publisher-specific improvements after an authorised test.

**BBC News:** The BBC is not in the full-text permission list. BBC pages are displayed as RSS previews with a prominent BBC link. This is intentional; public accessibility does not confer publication permission.

## Verification

Run `python3 -m unittest discover -s scripts -p 'test_publisher_reader.py'` and `python3 scripts/build-publisher-reader.py --out build/site/assets/reader-cache` after generating `assets/publisher-feeds.json`. The deployment workflow runs these checks and produces the cache automatically. No persistent application server or external API key is required.

## Operational notes

This is a deployment-time snapshot, not a real-time scraper; the site regenerates it when the deployment workflow runs. Deep-linked stories not in the current feed use the URL-supplied title as a labelled preview and retain their original publisher link. Data from a publisher's RSS feed may omit the complete story, and direct publisher links remain the definitive source.
