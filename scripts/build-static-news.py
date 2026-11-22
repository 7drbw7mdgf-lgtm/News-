"""Render crawlable static Pheme homepage, story landing pages, and sitemap.

Run against the build/site folder after copying index.html and assets.
No JavaScript needed for headlines or preview content. The interactive app
replaces the homepage fallback when JavaScript is available.
"""
from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
EDITION_DIR = ROOT / "editions"
SITE_URL = "https://pheme24.online"


def esc(value):
    return html.escape(str(value or ""), quote=True)


def shorten(s, n=175):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def public_slug(s):
    slug = s.get("id", "")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", slug):
        raise ValueError("Invalid story permalink slug")
    return slug


def top_meta(title, description, url, image=None):
    # Use our own stable logo for link previews: publisher hotlinks expire.
    image = image or SITE_URL + "/assets/images/pheme-logo.png"
    return "\n".join([
        '<meta name="description" content="' + esc(description) + '">',
        '<meta property="og:type" content="article">',
        '<meta property="og:site_name" content="Pheme">',
        '<meta property="og:title" content="' + esc(title) + '">',
        '<meta property="og:description" content="' + esc(description) + '">',
        '<meta property="og:url" content="' + esc(url) + '">',
        '<meta property="og:image" content="' + esc(image) + '">',
        '<meta name="twitter:card" content="summary">',
        '<meta name="twitter:title" content="' + esc(title) + '">',
        '<meta name="twitter:description" content="' + esc(description) + '">',
        '<link rel="canonical" href="' + esc(url) + '">',
    ])


STYLE = """
<style>
.static-news {max-width:1000px;margin:auto;padding:32px 20px 56px;font-family:system-ui,-apple-system,Arial,sans-serif;color:#302b24}
.static-news header{border-bottom:2px solid #35594b;margin-bottom:22px;padding-bottom:16px}
.static-news .static-brand{font-family:Georgia,serif;font-size:33px;color:#2f5d50;text-decoration:none;font-weight:bold}
.static-news h1{font:700 clamp(24px,4vw,36px)/1.2 Georgia,serif;margin:12px 0}
.static-news p{line-height:1.6;color:#594e40}
.static-news .static-article{padding:17px 0;border-bottom:1px solid #cbbfaa}
.static-news .static-article h2{font:700 22px/1.3 Georgia,serif;margin:6px 0}
.static-news a{color:#245c4b;text-decoration:none}.static-news a:hover{text-decoration:underline}
.static-news small{color:#756b5a}.static-news .static-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 25px}
@media(max-width:600px){.static-news .static-grid{grid-template-columns:1fr}}
</style>
"""


def story_url(story):
    return SITE_URL + "/stories/" + public_slug(story) + "/"


def cards(stories):
    return "\n".join(
        '<article class="static-article"><small>' + esc(story.get("topic", "").upper()) +
        ' · ' + esc(story.get("time", "")) + '</small><h2><a href="' + esc(story_url(story)) +
        '">' + esc(story["headline"]) + '</a></h2><p>' + esc(story.get("summary", "")) +
        '</p></article>' for story in stories
    )


def landing(story):
    url = story_url(story)
    title = story["headline"] + " | Pheme"
    desc = shorten(story.get("summary") or story["headline"])
    paragraphs = story.get("article", [])[:3]
    body = "\n".join("<p>" + esc(p) + "</p>" for p in paragraphs)
    origin = story.get("url", "")
    source = story.get("source", "")
    source_link = ""
    if origin.startswith("https://"):
        source_link = '<p><a href="' + esc(origin) + '" rel="noopener noreferrer">Lead publisher article: ' + esc(source) + '</a></p>'
    # No page-code dependency: static story remains readable for unfurlers.
    return """<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>""" + esc(title) + """</title>
""" + top_meta(title, desc, url) + STYLE + """
</head><body style="background:#eee6d8">
<main class="static-news"><header><a class="static-brand" href="/">Pheme</a><p>Independent cross-source news briefing</p></header>
<article><small>""" + esc(story.get("topic", "").upper()) + " · " + esc(story.get("publishedLabel") or story.get("time", "")) + """</small>
<h1>""" + esc(story["headline"]) + "</h1><p><strong>" + esc(desc) + "</strong></p>" + body + source_link + """
<p><a href="/?story=""" + quote(public_slug(story)) + """">Read this story with source comparisons on Pheme</a></p>
<p><a href="/">Browse the latest Pheme edition</a></p></article></main></body></html>"""


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "site"
    index = out / "index.html"
    if not index.exists():
        raise FileNotFoundError("Missing built index.html")
    editions = sorted(EDITION_DIR.glob("*.json"))
    if not editions:
        raise ValueError("No editions available")
    edition = json.loads(editions[-1].read_text(encoding="utf-8"))
    stories = edition["STORIES"]
    meta = edition.get("META", {})
    dated = esc(meta.get("rangeLong") or meta.get("dateLabel") or "Latest edition")
    summary = shorten("; ".join(s["headline"] for s in stories[:4]), 245)
    home_title = "Pheme — latest headlines and independent news coverage"
    base = index.read_text(encoding="utf-8")
    # Client-side script replaces the generated fallback instantly on JS-capable browsers.
    fallback = '<div class="static-news"><header><a class="static-brand" href="/">Pheme</a>' + \
        '<h1>Latest edition headlines</h1><p>' + dated + ' · ' + str(len(stories)) + \
        ' stories. Read source-based summaries and compare original coverage.</p></header>' + \
        '<section class="static-grid" aria-label="Latest headlines">' + cards(stories) + '</section></div>'
    if '<div id="app"></div>' not in base:
        raise ValueError("Cannot find application root for progressive HTML")
    base = base.replace('<div id="app"></div>', '<div id="app">' + fallback + '</div>')
    base = base.replace('</head>', top_meta(home_title, summary, SITE_URL + "/").replace('og:type" content="article"', 'og:type" content="website"') + STYLE + '\n</head>')
    base = re.sub(r'<meta name="description" content="[^"]*">', '', base, count=1)
    index.write_text(base, encoding="utf-8")

    # Give each story a unique URL for WhatsApp, Slack, iMessage and search engines.
    for story in stories:
        target = out / "stories" / public_slug(story) / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(landing(story), encoding="utf-8")
    urls = [SITE_URL + "/"] + [story_url(s) for s in stories]
    (out / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "".join("<url><loc>" + esc(url) + "</loc></url>" for url in urls) +
        "</urlset>\n", encoding="utf-8")
    print("Rendered " + str(len(stories)) + " crawlable story pages and a static homepage")


if __name__ == "__main__":
    main()
