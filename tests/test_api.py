"""Public API localization contract and explicit static resource boundary."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_debug_room import server as backend


class APIContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.static = self.base / 'static'
        self.static.mkdir()
        self.http = backend.create_server('127.0.0.1', 0, self.base / 'private', self.static)
        self.thread = threading.Thread(target=self.http.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.tokens = self.http.room.credentials

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def request(self, path, body=None, role='owner', headers=None, method=None):
        supplied = dict(headers or {})
        if role:
            supplied['Authorization'] = 'Bearer ' + self.tokens[role + '_token']
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
            supplied.setdefault('Content-Type', 'application/json')
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
        try:
            connection.request(method or ('POST' if body is not None else 'GET'), path, body, supplied)
            response = connection.getresponse()
            raw = response.read()
            value = (json.loads(raw) if response.getheader('Content-Type', '').startswith('application/json')
                     else raw)
            return response.status, value, dict(response.getheaders())
        finally:
            connection.close()

    def assert_error(self, expected_status, code, *args, **kwargs):
        status, result, _ = self.request(*args, **kwargs)
        self.assertEqual(status, expected_status, result)
        self.assertEqual(result.get('code'), code)
        self.assertIsInstance(result['error'], str)
        self.assertTrue(result['error'])
        self.assertFalse(any('\u4e00' <= char <= '\u9fff' for char in result['error']))

    def test_validation_and_permission_errors_have_stable_codes(self):
        cases = [
            (401, 'unauthorized', '/api/state', None, None),
            (403, 'owner_required', '/api/config', None, 'viewer'),
            (403, 'agent_required', '/api/agent/messages', {}, 'owner'),
            (400, 'invalid_config', '/api/config', {'unknown': True}, 'owner'),
            (400, 'invalid_max_turns', '/api/config', {'max_turns': 21}, 'owner'),
            (400, 'invalid_text', '/api/config', {'topic': ''}, 'owner'),
            (400, 'invalid_message', '/api/messages', [], 'owner'),
            (400, 'invalid_text', '/api/messages', {'content': 'x'}, 'owner'),
            (400, 'invalid_action', '/api/control', {'action': 'other'}, 'owner'),
            (400, 'invalid_cursor', '/api/state?after=-1', None, 'owner'),
            (404, 'not_found', '/api/unknown', None, 'owner'),
        ]
        for status, code, path, body, role in cases:
            with self.subTest(code=code, path=path):
                self.assert_error(status, code, path, body, role)

    def test_agent_state_errors_keep_alternation_pause_and_idempotency(self):
        body = {'content': '  original 文本\n', 'client_message_id': 'one'}
        self.assert_error(409, 'room_paused', '/api/agent/messages', body, 'server_agent')
        self.request('/api/control', {'action': 'start'})
        self.assert_error(409, 'wrong_turn', '/api/agent/messages', body, 'client_agent')
        self.assertEqual(self.request('/api/agent/messages', body, 'server_agent')[0], 200)
        self.assert_error(409, 'message_id_conflict', '/api/agent/messages',
                          dict(body, content='different'), 'server_agent')
        self.assertEqual(self.request('/api/agent/messages', body, 'server_agent')[0], 200)
        state = self.request('/api/state')[1]
        self.assertEqual(state['messages'][0]['content'], '  original 文本\n')
        self.assertEqual(len(state['messages']), 1)
        self.assertEqual(state['turns_used'], 1)

    def test_request_framing_errors_have_stable_codes(self):
        cases = [
            (400, 'unsupported_transfer_encoding', b'{}', {'Transfer-Encoding': 'chunked'}),
            (400, 'unsupported_content_type', b'{}', {'Content-Type': 'text/plain'}),
            (411, 'content_length_required', b'{}', {'Content-Length': ''}),
            (400, 'invalid_content_length', b'{}', {'Content-Length': '-1'}),
            (413, 'request_too_large', b'x' * 65537, {}),
            (400, 'invalid_json', b'{', {}),
        ]
        for status, code, body, headers in cases:
            with self.subTest(code=code):
                self.assert_error(status, code, '/api/messages', body,
                                  headers={'Content-Type': 'application/json', **headers})

    def test_internal_errors_do_not_expose_exception_details(self):
        with patch.object(self.http.room, 'state', side_effect=RuntimeError('private internal detail')):
            self.assert_error(500, 'internal_error', '/api/state')
            result = self.request('/api/state')[1]
            self.assertNotIn('private internal detail', result['error'])

    def test_fresh_room_uses_english_metadata_and_redaction_marker(self):
        state = self.request('/api/state')[1]
        self.assertEqual(state['title'], 'Agent Debug Room')
        self.assertEqual(state['topic'], 'Cross-agent debugging')
        token = self.tokens['viewer_token']
        body = {'content': 'Evidence ' + token, 'client_message_id': 'redaction'}
        posted = self.request('/api/messages', body)[1]
        self.assertEqual(posted['name'], 'Host')
        self.assertEqual(posted['content'], 'Evidence [redacted]')

    def test_static_assets_are_explicit_and_same_origin(self):
        assets = [('/i18n.mjs', 'text/javascript'), ('/favicon.svg', 'image/svg+xml')]
        for locale in ('en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ar'):
            assets.append((f'/locales/{locale}.json', 'application/json'))
        for route, content_type in assets:
            target = self.static / route.lstrip('/')
            target.parent.mkdir(exist_ok=True)
            target.write_text('{}' if route.endswith('.json') else 'fixture', encoding='utf-8')
            with self.subTest(route=route):
                status, _, headers = self.request(route, role=None)
                self.assertEqual(status, 200)
                self.assertTrue(headers['Content-Type'].startswith(content_type))
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                self.assertNotIn('Access-Control-Allow-Origin', headers)
        (self.static / 'locales' / 'private.json').write_text('{"secret":true}')
        (self.static / 'server.py').write_text('private implementation')
        for route in ('/locales/private.json', '/locales/../server.py',
                      '/locales/%2e%2e/server.py', '/locales/en.json/extra',
                      '/server.py', '/../server.py', '/locales/EN.json'):
            with self.subTest(route=route):
                self.assert_error(404, 'not_found', route, role=None)
        (self.static / 'locales' / 'en.json').unlink()
        self.assert_error(404, 'not_found', '/locales/en.json', role=None)


if __name__ == '__main__':
    unittest.main()
