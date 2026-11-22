"""Apply checked-in source-backed Pheme articles to their matching editions."""
import json
from pathlib import Path
from native_articles import apply_editorial, article_is_ready

root = Path(__file__).resolve().parents[1]
for path in sorted((root / 'editions').glob('*.json'))[-1:]:
    edition = json.loads(path.read_text())
    apply_editorial(edition['STORIES'], edition['COVERAGE'], edition)
    ready = sum(article_is_ready(story) for story in edition['STORIES'])
    if ready == len(edition['STORIES']):
        edition['META']['articlePolicy'] = 'source-based-v1'
        edition['META']['writer'] = 'editorial'
        edition['META']['digest'] = [s['headline'] + ' (' + s['source'] + ')' for s in edition['STORIES'][:4]]
    path.write_text(json.dumps(edition, ensure_ascii=False, indent=1) + '\n')
    print(path.name + ': ' + str(ready) + '/' + str(len(edition['STORIES'])) + ' source-backed articles')
