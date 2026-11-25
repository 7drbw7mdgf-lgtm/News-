import io
import json
import unittest
from unittest.mock import Mock, patch

from local_writer import ask_local_writer


class LocalWriterTest(unittest.TestCase):
    def setUp(self):
        self.event = {'outlets': {
            'North Press': {'title': 'Council approves library extension', 'excerpt':
                ' '.join(['The council discussed the proposed library extension during its meeting.'] * 8)},
            'Town News': {'title': 'Library prepares for construction', 'excerpt':
                ' '.join(['An extension will provide the library with extra space for readers.'] * 8)},
        }}

    def test_syndicated_copy_does_not_make_two_sources(self):
        self.event['outlets']['Town News']['excerpt'] = self.event['outlets']['North Press']['excerpt']
        with patch('local_writer.urllib.request.urlopen') as request:
            self.assertEqual(ask_local_writer(self.event), {'reject': True})
            request.assert_not_called()

    def test_checks_claims_individually_and_preserves_source_order(self):
        first = ('Residents will be able to use a new reading room alongside the existing library facilities. '
                 'Councillors approved the proposal after reviewing the plans at a public meeting on Wednesday. '
                 'The project also provides additional space for after-school activities that take place throughout the week.')
        second = ('The current entrance will remain open during the building work so that people can still return their books. '
                  'Staff plan to move the afternoon reading group into a different room while contractors work. '
                  'The library will use its regular newsletter to let visitors know when the new room opens.')
        first_parts = first.split('. ')
        second_parts = second.split('. ')
        draft = {'same_news_event': True, 'headline': 'Unverified headline', 'a4': 'Unsupported assertion here today.',
                 'b4': ''}
        for prefix, sentences in [('a', first_parts), ('b', second_parts)]:
            for n, sentence in enumerate(sentences, 1):
                draft[prefix + str(n)] = sentence.rstrip('.') + '.'
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(draft)}}]}
        checker = Mock()
        checker.supports.side_effect = lambda text, claim: not claim.startswith(('Unverified', 'Unsupported'))
        with patch('local_writer.urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())), \
                patch('local_writer.source_checker', return_value=checker):
            story = ask_local_writer(self.event)
        self.assertEqual(story['article'], [first, second])
        self.assertEqual(story['article_sources'], ['North Press', 'Town News'])
        self.assertEqual(story['headline'], 'Council approves library extension')
