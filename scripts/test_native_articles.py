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

audio_spec = importlib.util.spec_from_file_location('pheme_audio', ROOT / 'scripts/build-audio.py')
audio_builder = importlib.util.module_from_spec(audio_spec)
audio_spec.loader.exec_module(audio_builder)


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

    def test_audio_script_normalisation_and_cue_alignment(self):
        spoken = audio_builder.prepare_spoken_text('GTA VI raised $3.79bn — while RTÉ covered GLP-1s.')
        self.assertIn('GTA Six', spoken)
        self.assertIn('3.79 billion dollars', spoken)
        self.assertIn('R T E', spoken)
        self.assertIn('G L P ones', spoken)

        parts = [
            'Headline about global markets.',
            'Stocks fell sharply across London and New York on Friday.',
            'Central banks signalled caution over future interest rate cuts.',
        ]
        events = [
            {'offset': 0.05, 'duration': 2.5, 'text': 'Headline about global markets.'},
            {'offset': 2.80, 'duration': 4.1, 'text': 'Stocks fell sharply across London and New York on Friday.'},
            {'offset': 7.20, 'duration': 4.4, 'text': 'Central banks signalled caution over future interest rate cuts.'},
        ]
        cues = audio_builder.align_paragraph_cues(parts, events, 12.0)
        self.assertEqual(cues, [2.8, 7.2])

    def test_kokoro_sentence_splitting_and_voice_mapping(self):
        long_para = 'First sentence about markets. ' + ('This is a long clause with details, ' * 12) + 'final ending.'
        chunks = audio_builder.split_sentences(long_para, max_chars=200)
        self.assertGreaterEqual(len(chunks), 3)
        self.assertTrue(all(len(c) <= 240 for c in chunks))
        self.assertGreaterEqual(len(audio_builder.VOICES), 12)
        ids = {v['id'] for v in audio_builder.VOICES}
        for removed in ('vivienne', 'remy', 'ryan', 'thomas'):
            self.assertNotIn(removed, ids)
        el_ids = {v['elevenlabs'] for v in audio_builder.VOICES}
        for expected_el in (
            'ZwLTvq6uCfb4W00YFl7F',
            'ZF6FPAbjXT4488VcRRnw',
            'Se2Vw1WbHmGbBbyWTuu4',
            'NNl6r8mD7vthiJatiJt1',
            'kBag1HOZlaVBH7ICPE8x',
        ):
            self.assertIn(expected_el, el_ids)
        for voice in audio_builder.VOICES:
            for key in ('id', 'label', 'accent', 'tagline', 'edge', 'kokoro', 'kokoro_lang', 'openai', 'elevenlabs'):
                self.assertTrue(voice.get(key), f"Missing {key} on voice {voice.get('id')}")
        with patch.dict(audio_builder.os.environ, {'PHEME_TTS_PROVIDER': 'kokoro'}):
            self.assertEqual(audio_builder.choose_provider(), 'kokoro')

    def test_edge_failure_falls_back_automatically_to_kokoro(self):
        import asyncio
        story = {
            'id': 'sample-fallback-story',
            'headline': 'Sample headline',
            'article': ['First paragraph of reporting with clear facts.', 'Second paragraph with additional context.'],
        }
        fake_mp3 = b'ID3' + b'\x00' * 2048
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            out_dir = root / 'out'
            cache_dir = root / 'cache'
            async def boom(*_a, **_kw):
                raise RuntimeError('Simulated edge-tts outage')
            async def run_case():
                with patch.object(audio_builder, 'synth_edge', side_effect=boom), \
                     patch.object(audio_builder, 'synth_kokoro_sync', return_value=(fake_mp3, 12.5, [2.1, 7.4])) as mock_kokoro, \
                     patch.object(audio_builder.asyncio, 'sleep', return_value=None):
                    res = await audio_builder.generate_one(
                        story, audio_builder.VOICES[0], 'edge', out_dir, cache_dir,
                        asyncio.Semaphore(2), asyncio.Semaphore(1),
                    )
                    self.assertIsNotNone(res)
                    self.assertEqual(res['provider'], 'kokoro')
                    self.assertEqual(res['cues'], [2.1, 7.4])
                    self.assertTrue((out_dir / res['file']).exists())
                    mock_kokoro.assert_called_once()
            asyncio.run(run_case())


if __name__ == '__main__':
    unittest.main()
