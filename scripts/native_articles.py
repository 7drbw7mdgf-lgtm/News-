"""Quality checks and source-backed editorial articles for the Pheme reader."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
BOILERPLATE = re.compile(r"Across Pheme[’']s|Use the leaning filter|Pheme is tracking|Reported by \d+ outlets|First reported by|Coverage: \d|select an outlet to read|open any original article", re.I)


def article_is_ready(story):
    article = story.get('article')
    if not isinstance(article, list) or len(article) < 2:
        return False
    if not all(isinstance(p, str) and p.strip() for p in article):
        return False
    text = ' '.join(article)
    return len(text.split()) >= 80 and not BOILERPLATE.search(text)


def editorial_articles():
    result = {}
    for path in sorted((ROOT / 'articles').glob('*.json')):
        edition = json.loads(path.read_text())
        for story_id, article in edition['stories'].items():
            result[story_id] = dict(article, updatedAt=edition['updatedAt'])
    return result


def apply_editorial(stories, coverage, previous=None):
    edits = editorial_articles()
    previous_by_id = {s['id']: s for s in (previous or {}).get('STORIES', [])}
    for story in stories:
        edit = edits.get(story['id'])
        if article_is_ready(story) and (not edit or story.get('articleUpdatedAt', '') >= edit['updatedAt']):
            story['articleStatus'] = 'ready'
            continue
        if not edit:
            continue
        sources = {row[0]: {'name': row[0], 'url': row[2]} for row in coverage[story['id']]}
        for source in previous_by_id.get(story['id'], {}).get('articleSources', []):
            sources.setdefault(source['name'], source)
        selected = [sources[name] for name in edit['sourceNames'] if name in sources]
        if len(selected) != len(edit['sourceNames']):
            raise ValueError('Missing editorial source reference: ' + story['id'])
        candidate = dict(story, article=edit['article'])
        if not article_is_ready(candidate):
            raise ValueError('Editorial article failed its quality check: ' + story['id'])
        story.update({key: edit[key] for key in ('headline', 'summary', 'article')})
        story['points'] = edit.get('points', [])
        story['articleStatus'] = 'ready'
        story['articleUpdatedAt'] = edit['updatedAt']
        story['articleSources'] = selected
        story['articleOrigin'] = 'editorial'
