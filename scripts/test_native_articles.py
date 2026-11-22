import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_articles import article_is_ready, apply_editorial, ROOT
import story_images

spec = importlib.util.spec_from_file_location('pheme_writer', ROOT / 'scripts/make-edition.py')
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


def event():
    names = ['Example News', 'Daily Reporting', 'World Wire']
    return {
        'topic': 'world',
        'outlets': {name: {'title': 'New transport route opens after construction', 'url': 'https://example.com/' + str(i), 'published': '2026-11-22T08:00:00+00:00'} for i, name in enumerate(names)},
        'ratings': {name: {'code': 'C', 'questionable': False} for name in names},
    }


class NativeArticleTests(unittest.TestCase):
    def test_coverage_template_cannot_be_an_article(self):
        story = {'article': [
            'A reported event appeared in the news. ' * 10,
            'Across Pheme’s 29-source sample, this story is covered by centre-rated outlets.',
            'Use the leaning filter tabs below to inspect the reporting.',
        ]}
        self.assertFalse(article_is_ready(story))

    def test_no_writer_produces_an_unpublished_draft(self):
        with patch.object(writer, 'ask_writer', return_value=None):
            story, _, _ = writer.write_story(event(), set())
        self.assertNotIn('article', story)
        self.assertNotIn('articleStatus', story)
        self.assertEqual(story['points'], [])
        self.assertFalse(article_is_ready(story))

    def test_generated_filler_is_rejected_even_with_valid_metadata(self):
        generated = {
            'headline': 'New transport route opens after construction',
            'summary': 'A route has opened.',
            'article_sources': ['Example News'],
            'article': ['Across Pheme’s 29-source sample, this story is covered by many outlets. ' * 8, 'Use the leaning filter tabs below to compare the reporting.'],
        }
        with patch.object(writer, 'ask_writer', return_value=generated):
            story, _, _ = writer.write_story(event(), set())
        self.assertNotIn('article', story)
        self.assertNotIn('articleStatus', story)

    def test_editorial_replacement_contains_the_gta_story(self):
        edition = json.loads((ROOT / 'editions/2026-11-22.json').read_text())
        story = copy.deepcopy(next(s for s in edition['STORIES'] if s['id'] == 'love-carjackings-video-game'))
        story['article'] = ['Across Pheme’s 29-source sample, this is covered by many outlets.']
        story.pop('articleUpdatedAt', None)
        apply_editorial([story], edition['COVERAGE'])
        self.assertTrue(article_is_ready(story))
        self.assertIn('$3.79 billion', ' '.join(story['article']))
        self.assertIn('13-year wait', ' '.join(story['article']))
        self.assertTrue(story['articleSources'])

    def test_entire_current_edition_has_real_articles_and_sources(self):
        edition = json.loads((ROOT / 'editions/2026-11-22.json').read_text())
        for story in edition['STORIES']:
            with self.subTest(story=story['id']):
                self.assertTrue(article_is_ready(story))
                self.assertEqual(story['articleStatus'], 'ready')
                self.assertTrue(story['articleSources'])

    def test_writer_outage_cannot_replace_the_published_edition(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'editions').mkdir()
            (root / 'feeds').mkdir()
            (root / 'feeds/feeds.json').write_text('[]')
            previous = root / 'editions/2026-11-22.json'
            original = json.dumps({'STORIES': [], 'COVERAGE': {}, 'FOLLOWED': []})
            previous.write_text(original)
            candidates = root / 'candidates.json'
            candidates.write_text('{"candidateGroups": []}')
            with patch.object(writer, 'ROOT', root), patch.object(writer, 'build_events', return_value=[event()]), patch.object(writer, 'choose', return_value=[event()]), patch.object(writer, 'ask_writer', return_value=None), patch.object(writer, 'apply_editorial'), patch.object(writer.sys, 'argv', ['make-edition.py', str(candidates)]), patch.dict(writer.os.environ, {'PHEME_MIN_STORIES': '1'}), contextlib.redirect_stderr(io.StringIO()):
                result = writer.main()
            self.assertEqual(result, 1)
            self.assertEqual(previous.read_text(), original)

    def test_story_image_extractor_filters_generic_and_keeps_article_photos(self):
        html_ok = '<head><meta property="og:image" content="https://ichef.bbci.co.uk/news/1200/photo.jpg"><meta property="og:image:alt" content="Press conference"></head>'
        url, alt = story_images.extract_meta_image(html_ok, 'https://www.bbc.co.uk/news/example')
        self.assertEqual(url, 'https://ichef.bbci.co.uk/news/1200/photo.jpg')
        self.assertEqual(alt, 'Press conference')

        html_logo = '<head><meta property="og:image" content="https://static.seekingalpha.com/assets/og_image_1200-abc.png"></head>'
        url2, _ = story_images.extract_meta_image(html_logo, 'https://seekingalpha.com/news/1')
        self.assertIsNone(url2)

    def test_gazetteer_maps_previously_unmapped_entities(self):
        cases = [
            ('Judge approves Bayer Roundup settlement in Missouri', 'St. Louis, Missouri, USA'),
            ('Mayo Clinic analysis examines GLP-1 medicines and prediabetes', 'Rochester, Minnesota, USA'),
            ('Grand Theft Auto VI launch generates record sales for Rockstar', 'Edinburgh, Scotland, UK'),
            ('Signal restricts screenshots over AI assistant concerns', 'Mountain View, California, USA'),
        ]
        for headline, expected in cases:
            loc = writer.infer_location({'outlets': {}}, headline)
            self.assertIsNotNone(loc, headline)
            self.assertEqual(loc['label'], expected)


if __name__ == '__main__':
    unittest.main()
