"""Real HTTP tests for the authenticated bridge; no model services are used."""
import concurrent.futures
import json
from pathlib import Path
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request


from agent_debug_room import server as backend


class RoomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / 'private'
        self.open_room()

    def open_room(self):
        self.http = backend.create_server('127.0.0.1', 0, self.runtime)
        self.thread = threading.Thread(target=self.http.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.credentials = json.loads((self.runtime / 'credentials.json').read_text())
        self.tokens = {role: self.credentials.get(role + '_token', 'missing-' + role)
                       for role in ('owner', 'viewer', 'server_agent', 'client_agent')}

    def close_room(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)

    def tearDown(self):
        self.close_room()
        self.temp.cleanup()

    def request(self, path, data=None, token='owner', raw=None):
        token = self.tokens.get(token, token)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        req = urllib.request.Request(self.url + path, data=body, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            content = response.read()
            parsed = json.loads(content) if content else None
            return response.status, parsed, response.headers

    def state(self, token='owner'):
        status, result, _ = self.request('/api/state', token=token)
        self.assertEqual(status, 200)
        return result

    def post(self, actor, message_id, content='Agent 的判断', **extra):
        return self.request('/api/agent/messages', dict(content=content,
                            client_message_id=message_id, **extra), token=actor + '_agent')

    def start(self, max_turns=20):
        self.assertEqual(self.request('/api/config', {'max_turns': max_turns})[0], 200)
        self.assertEqual(self.request('/api/control', {'action': 'start'})[0], 200)

    def test_defaults_four_private_tokens_and_no_model_configuration(self):
        self.assertEqual(set(self.credentials), {'owner_token', 'viewer_token',
                                                'server_agent_token', 'client_agent_token'})
        self.assertEqual(len(set(self.credentials.values())), 4)
        self.assertTrue(all(len(value) >= 43 for value in self.credentials.values()))
        self.assertEqual(stat.S_IMODE(self.runtime.stat().st_mode), 0o700)
        for name in ('credentials.json', 'config.json', 'transcript.sqlite3'):
            self.assertEqual(stat.S_IMODE((self.runtime / name).stat().st_mode), 0o600)
        state = self.state()
        self.assertEqual(state['mode'], 'agent_bridge')
        self.assertFalse(state['running'])
        self.assertTrue(state['paused'])
        self.assertEqual(state['next_speaker'], 'server')
        self.assertEqual(state['max_turns'], 20)
        self.assertEqual(state['participants'], {'server': {'last_seen': None},
                                                'client': {'last_seen': None}})
        self.assertEqual(set(self.request('/api/config')[1]), {'topic', 'context', 'max_turns'})

    def test_auth_permissions_presence_and_security_headers(self):
        self.assertEqual(self.request('/healthz', token=None)[:2], (200, {'ok': True}))
        self.assertEqual(self.request('/api/state', token=None)[0], 401)
        self.assertEqual(self.request('/api/state?token=' + self.tokens['owner'], token=None)[0], 401)
        for role in self.tokens:
            state = self.state(role)
            self.assertEqual(state['role'], role)
            for token in self.tokens.values():
                self.assertNotIn(token, json.dumps(state))
        state = self.state()
        self.assertIsNotNone(state['participants']['server']['last_seen'])
        self.assertIsNotNone(state['participants']['client']['last_seen'])
        for role in ('viewer', 'server_agent', 'client_agent'):
            for path in ('/api/config', '/api/invite'):
                self.assertEqual(self.request(path, token=role)[0], 403)
            for path in ('/api/config', '/api/control', '/api/messages'):
                self.assertEqual(self.request(path, {}, token=role)[0], 403)
        for role in ('owner', 'viewer'):
            self.assertEqual(self.request('/api/agent/messages', {}, token=role)[0], 403)
        invite = self.request('/api/invite')[1]
        self.assertEqual(set(invite), {'viewer_token', 'server_agent_token', 'client_agent_token'})
        self.assertNotIn(self.tokens['owner'], json.dumps(invite))
        headers = self.request('/api/state')[2]
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_metadata_only_configuration_and_start_needs_no_provider(self):
        self.assertEqual(self.request('/api/config', {'topic': '真实事件', 'context': '实际会话证据'})[0], 200)
        self.assertEqual(self.request('/api/config', {'max_turns': 4})[0], 200)
        self.assertEqual(self.state()['context'], '实际会话证据')
        for body in ({'server': {}}, {'client': {}}, {'api_key': 'not-used'}, {'max_tokens': 100},
                     {'max_turns': 0}, {'max_turns': 21}, {'max_turns': True}, {'topic': ''}):
            self.assertEqual(self.request('/api/config', body)[0], 400)
        self.assertEqual(self.request('/api/control', {'action': 'start'})[0], 200)
        self.assertFalse(self.state()['paused'])
        self.assertFalse(self.state()['running'])

    def test_actual_http_posts_alternate_and_bind_authenticated_role(self):
        self.start(max_turns=4)
        status, opening, _ = self.post('server', 'opening', '当前助手的开场', role='client', name='spoof')
        self.assertEqual(status, 200)
        self.assertEqual(opening['role'], 'server')
        self.assertEqual(opening['name'], 'Server agent')
        self.assertEqual(self.post('server', 'out-of-turn')[0], 409)
        status, answer, _ = self.post('client', 'response', '对方已有 Agent 的回复')
        self.assertEqual(status, 200)
        self.assertEqual(answer['role'], 'client')
        self.assertEqual(answer['name'], 'Client agent')
        state = self.state('viewer')
        self.assertEqual([m['content'] for m in state['messages']],
                         ['当前助手的开场', '对方已有 Agent 的回复'])
        self.assertEqual(state['turns_used'], 2)
        self.assertEqual(state['next_speaker'], 'server')
        self.assertFalse(state['running'])
        self.assertEqual(self.request('/api/state?after=' + str(opening['id']))[1]['messages'], [answer])

    def test_pause_budget_and_duplicate_retry_after_pause(self):
        self.assertEqual(self.post('server', 'paused')[0], 409)
        self.start(max_turns=2)
        self.assertEqual(self.post('server', 'one')[0], 200)
        self.assertEqual(self.request('/api/control', {'action': 'pause'})[0], 200)
        self.assertEqual(self.post('client', 'two')[0], 409)
        self.assertEqual(self.request('/api/control', {'action': 'start'})[0], 200)
        answer = self.post('client', 'two')
        self.assertEqual(answer[0], 200)
        self.assertTrue(self.state()['paused'])
        self.assertEqual(self.state()['turns_used'], 2)
        self.assertEqual(self.post('client', 'two')[1], answer[1])
        self.assertEqual(self.post('server', 'three')[0], 409)
        self.assertEqual(self.request('/api/control', {'action': 'start'})[0], 200)
        self.assertEqual(self.state()['turns_used'], 0)
        self.assertEqual(self.post('server', 'three')[0], 200)

    def test_concurrent_agent_retries_append_once_and_cannot_reuse_other_role_id(self):
        self.start()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.post('server', 'retry'), range(6)))
        self.assertEqual([result[0] for result in results], [200] * 6)
        self.assertEqual(len({result[1]['id'] for result in results}), 1)
        self.assertEqual(len(self.state()['messages']), 1)
        self.assertEqual(self.state()['turns_used'], 1)
        self.assertEqual(self.post('server', 'retry', 'changed text')[0], 409)
        self.assertEqual(self.post('client', 'retry')[0], 409)
        self.assertEqual(self.post('client', 'client-new')[0], 200)

    def test_human_messages_do_not_consume_or_change_agent_turn(self):
        body = {'content': '  主持人的原文\n', 'client_message_id': 'human-id'}
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request('/api/messages', body), range(6)))
        self.assertEqual([result[0] for result in results], [200] * 6)
        self.assertEqual(results[0][1]['name'], 'Host')
        self.assertEqual(results[0][1]['content'], '  主持人的原文\n')
        self.assertEqual(len(self.state()['messages']), 1)
        self.assertEqual(self.state()['turns_used'], 0)
        self.assertEqual(self.state()['next_speaker'], 'server')
        self.assertEqual(self.request('/api/messages', dict(body, content='主持人的原文'))[0], 409)
        self.start()
        self.assertEqual(self.post('server', 'human-id', body['content'])[0], 409)

    def test_restart_preserves_messages_progress_and_tokens_but_pauses(self):
        self.start(max_turns=4)
        self.post('server', 'persistent')
        before = self.state()
        tokens = dict(self.credentials)
        self.close_room()
        self.open_room()
        after = self.state()
        self.assertEqual(self.credentials, tokens)
        self.assertEqual(after['messages'], before['messages'])
        self.assertEqual(after['next_speaker'], 'client')
        self.assertEqual(after['turns_used'], 1)
        self.assertTrue(after['paused'])
        self.assertFalse(after['running'])
        self.assertIsNone(after['participants']['server']['last_seen'])
        self.assertEqual(self.post('client', 'restart-paused')[0], 409)
        self.assertEqual(self.request('/api/control', {'action': 'start'})[0], 200)
        self.assertEqual(self.post('client', 'restart-resumed')[0], 200)

    def test_legacy_migration_preserves_owner_viewer_context_and_removes_provider_config(self):
        old_tokens = {key: value for key, value in self.credentials.items()
                      if key in ('owner_token', 'viewer_token')}
        self.close_room()
        (self.runtime / 'credentials.json').write_text(json.dumps(old_tokens))
        (self.runtime / 'config.json').write_text(json.dumps({
            'topic': '既有主题', 'context': '既有上下文', 'max_turns': 8, 'max_tokens': 1200,
            'server': {'api_key': 'obsolete-fixture-key'}, 'client': {'api_key': ''}}))
        self.open_room()
        self.assertEqual(self.credentials['owner_token'], old_tokens['owner_token'])
        self.assertEqual(self.credentials['viewer_token'], old_tokens['viewer_token'])
        self.assertEqual(set(self.credentials), {'owner_token', 'viewer_token',
                                                'server_agent_token', 'client_agent_token'})
        saved = json.loads((self.runtime / 'config.json').read_text())
        self.assertEqual(saved, {'topic': '既有主题', 'context': '既有上下文', 'max_turns': 8})
        self.assertNotIn('obsolete-fixture-key', json.dumps(self.state()))
        self.assertNotIn('obsolete-fixture-key', (self.runtime / 'config.json').read_text())

    def test_invalid_inputs_body_limits_and_token_redaction(self):
        for path, token in (('/api/messages', 'owner'), ('/api/agent/messages', 'server_agent')):
            for body in ({}, {'content': '', 'client_message_id': 'x'},
                         {'content': 'x' * 16001, 'client_message_id': 'x'},
                         {'content': 'text', 'client_message_id': ''}, []):
                self.assertEqual(self.request(path, body, token=token)[0], 400)
            self.assertEqual(self.request(path, token=token, raw=b'{')[0], 400)
            self.assertEqual(self.request(path, token=token, raw=b'x' * 65537)[0], 413)
        for after in ('-1', 'NaN', '1.2', ''):
            self.assertEqual(self.request('/api/state?after=' + after)[0], 400)
        self.start()
        self.post('server', 'redact', 'Do not expose ' + self.tokens['client_agent'])
        serialized = json.dumps(self.state('viewer'))
        self.assertNotIn(self.tokens['client_agent'], serialized)
        for path in ('/server.py', '/credentials.json', '/../server.py', '/api/unknown'):
            self.assertEqual(self.request(path)[0], 404)


if __name__ == '__main__':
    unittest.main(verbosity=2)
