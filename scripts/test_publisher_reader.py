"""Regression checks for the server-side publisher reader policy and parsing."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parent / "build-publisher-reader.py"
spec = importlib.util.spec_from_file_location("pheme_publisher_reader", MODULE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class PublisherReaderTests(unittest.TestCase):
    def test_canonical_ignores_rss_tracking_parameters(self):
        expected = "https://www.bbc.co.uk/news/articles/cm4g10p2r0g9o"
        self.assertEqual(
            reader.canonical(expected + "?at_medium=RSS&at_campaign=rss"),
            expected,
        )

    def test_no_http_or_private_hosts_in_canonical_urls(self):
        self.assertEqual(reader.canonical("http://www.bbc.co.uk/news/a"), "")
        self.assertEqual(reader.canonical("https://name:pass@www.bbc.co.uk/news/a"), "")
        self.assertEqual(reader.canonical("https://www.bbc.co.uk:8443/news/a"), "")

    def test_unconfirmed_republication_has_no_extraction(self):
        # Permissions file ships empty: no source is assumed authorised.
        self.assertIsInstance(reader.authorised_rules(), dict)
        self.assertNotIn("BBC News", reader.authorised_rules())

    def test_reader_excludes_navigation_and_script(self):
        doc = ('<html><nav>Long navigation links that should never appear in content</nav>'
               '<article><h1>A news headline</h1>'
               '<p>This is a sufficiently long example paragraph of journalistic '
               'body content intended for the user to read in the native story view.</p>'
               '<script>secret embedded application logic should never be included</script>'
               '</article></html>')
        parser = reader.BasicArticleParser()
        parser.feed(doc)
        self.assertEqual(len(parser.paragraphs), 1)
        self.assertIn("sufficiently long", parser.paragraphs[0])
        self.assertNotIn("navigation", " ".join(parser.paragraphs))
        self.assertNotIn("script", " ".join(parser.paragraphs))


if __name__ == "__main__":
    unittest.main()
