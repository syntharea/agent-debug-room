"""Remote helpers: offline boundaries and optional real Firebase Emulator coverage."""
import concurrent.futures
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def invitation(**changes):
    value = {'protocol': 'agent-debug-room/firebase-v1',
             'url': 'https://example.web.app/r/' + 'r' * 32,
             'room_id': 'r' * 32, 'role': 'server_agent', 'token': 't' * 43,
             'firebase': {'apiKey': 'emulator-only-key', 'projectId': 'demo-agent-debug-room',
                          'appId': 'emulator-test-app'}}
    value.update(changes)
    return value


class RemoteBoundaryTests(unittest.TestCase):
    def test_remote_state_derives_pause_from_expiry_and_deletion(self):
        from agent_debug_room.cloud_client import CloudClient
        with tempfile.TemporaryDirectory() as temporary:
            client = CloudClient(Path(temporary), invitation())
            room = {'created_at': '2099-01-01T00:00:00Z', 'topic': 'Fixture', 'context': '',
                    'paused': False, 'next_speaker': 'server', 'turns_used': 0, 'max_turns': 20,
                    'seq': 0, 'deleting': False}
            cases = [('active', {}, False, False),
                     ('expired', {'created_at': '2020-01-01T00:00:00Z'}, True, True),
                     ('deleting', {'deleting': True}, True, False)]
            for label, changes, expected_paused, expected_expired in cases:
                with self.subTest(room=label), patch.object(client, '_get', return_value={**room, **changes}), \
                        patch.object(client, '_fire', return_value=[]):
                    state = client.request('/api/state')
                    self.assertEqual(state['paused'], expected_paused)
                    self.assertEqual(state['expired'], expected_expired)
                    self.assertEqual(state['deleting'], changes.get('deleting', False))

    def test_rest_transaction_uses_atomic_version_commit_when_begin_is_denied(self):
        from agent_debug_room.cloud_client import CloudClient, CloudError, _encode
        with tempfile.TemporaryDirectory() as temporary:
            client = CloudClient(Path(temporary), invitation())
            room_name = client.documents + '/' + client.room_path
            message_name = room_name + '/messages/version-test'
            room_fields = {'created_at': {'timestampValue': '2099-01-01T00:00:00Z'},
                           **{key: _encode(value) for key, value in {
                               'topic': 'Fixture', 'context': '', 'paused': False, 'next_speaker': 'server',
                               'turns_used': 0, 'max_turns': 20, 'seq': 0, 'deleting': False}.items()}}
            document = {'name': room_name, 'fields': room_fields, 'updateTime': '2026-11-01T00:00:00Z'}
            stored = {}
            conflicts = []
            def firestore(path, body=None):
                if path == ':beginTransaction':
                    raise CloudError('unauthorized', 401, 'Production rejects the server transaction API')
                if path == ':batchGet':
                    if 'transaction' in body or 'newTransaction' in body:
                        raise CloudError('unauthorized', 401, 'No built-in server transactions')
                    name = body['documents'][0]
                    if name == room_name:
                        return [{'found': document}]
                    return [{'missing': name}]
                if path == ':commit':
                    if 'transaction' in body:
                        raise CloudError('unauthorized', 401, 'No built-in server transactions')
                    message, room = body['writes']
                    if message.get('currentDocument') != {'exists': False}:
                        raise CloudError('unauthorized', 401, 'The new message must be immutable')
                    if room.get('currentDocument') != {'updateTime': document['updateTime']}:
                        raise CloudError('unavailable', 409, 'The room version changed', True)
                    if not conflicts:
                        conflicts.append(True)
                        document['updateTime'] = '2026-11-01T00:00:01Z'
                        raise CloudError('unavailable', 409, 'A concurrent metadata update won', True)
                    stored[message_name] = {**message['update'], 'fields': {
                        **message['update']['fields'], 'created_at': {'timestampValue': '2026-11-01T00:00:02Z'}}}
                    return {}
                if path == '/' + client.room_path + '/messages/version-test':
                    if message_name not in stored:
                        raise CloudError('not_found', 404, 'Message not found')
                    return stored[message_name]
                raise AssertionError('Unexpected Firestore operation: ' + path)
            with patch.object(client, '_fire', side_effect=firestore):
                result = client.request('/api/agent/messages',
                                        {'content': 'original evidence', 'client_message_id': 'version-test'})
            self.assertEqual(result['id'], 1)
            self.assertEqual(result['role'], 'server')
            self.assertEqual(result['content'], 'original evidence')
            self.assertEqual(len(stored), 1)
            self.assertEqual(conflicts, [True])

    def test_connect_rejects_invalid_invite_before_any_auth_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            invite = Path(temporary) / 'bad.json'
            invite.write_text(json.dumps(invitation(url='http://example.web.app/r/' + 'r' * 32)))
            result = subprocess.run([sys.executable, '-m', 'agent_debug_room.cli', '--state-dir',
                                     str(Path(temporary) / 'state'), 'connect', '--invite-file', str(invite)],
                                    text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid_invite', result.stderr)
            self.assertNotIn('t' * 43, result.stderr + result.stdout)
            self.assertFalse((Path(temporary) / 'state' / 'cloud-session.json').exists())

    def test_cloud_profile_refuses_python_polling_with_sdk_instructions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'cloud-session.json').write_text(json.dumps(invitation()))
            result = subprocess.run([sys.executable, '-m', 'agent_debug_room.notify', '--state-dir',
                                     str(directory), '--run', 'fixture-run', '--sender', 'fixture-terminal',
                                     '--once'], text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('cloud/watch.mjs', result.stderr)
            self.assertIn('npm ci --omit=dev', result.stderr)
            self.assertNotIn('t' * 43, result.stdout + result.stderr)

    def test_realtime_watcher_rejects_non_agent_profiles_without_sending(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'cloud-session.json').write_text(json.dumps(invitation(role='viewer')))
            result = subprocess.run(['node', 'cloud/watch.mjs', '--state-dir', str(directory),
                                     '--run', 'fixture', '--sender', 'fixture', '--once'], cwd=ROOT,
                                    text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('agent_required', result.stderr)
            self.assertNotIn('t' * 43, result.stdout + result.stderr)

    def test_invite_rejects_remote_emulator_origins_and_inconsistent_room_urls(self):
        from agent_debug_room.cloud_client import CloudError, validate_invite
        invalid = [invitation(room_id='../escape'), invitation(token='short'),
                   invitation(url='https://user:secret@example.web.app/r/' + 'r' * 32),
                   invitation(url='https://example.web.app/r/' + 's' * 32),
                   invitation(emulators={'auth': 'http://public.example:9099',
                                         'firestore': {'host': '127.0.0.1', 'port': 8080}}),
                   invitation(emulators={'auth': 'http://127.0.0.1:9099/path',
                                         'firestore': {'host': 'public.example', 'port': 8080}})]
        for value in invalid:
            with self.subTest(fields=sorted(value)):
                with self.assertRaises(CloudError) as caught:
                    validate_invite(value)
                self.assertEqual(caught.exception.code, 'invalid_invite')
        valid = invitation(emulators={'auth': 'http://127.0.0.1:9099',
                                      'firestore': {'host': 'localhost', 'port': 8080}})
        self.assertEqual(validate_invite(valid), valid)

    def test_connect_never_overwrites_existing_local_or_other_remote_room(self):
        from agent_debug_room.cloud_client import CloudError, connect
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            invite = directory / 'invite.json'
            invite.write_text(json.dumps(invitation()))
            state = directory / 'state'
            state.mkdir()
            original = '{"fixture":"keep"}'
            (state / 'credentials.json').write_text(original)
            with self.assertRaises(CloudError):
                connect(state, invite)
            self.assertEqual((state / 'credentials.json').read_text(), original)
            (state / 'credentials.json').unlink()
            previous = invitation(room_id='s' * 32, url='https://example.web.app/r/' + 's' * 32)
            (state / 'cloud-session.json').write_text(json.dumps(previous))
            with self.assertRaises(CloudError):
                connect(state, invite)
            self.assertEqual(json.loads((state / 'cloud-session.json').read_text()), previous)


@unittest.skipUnless(os.environ.get('FIRESTORE_EMULATOR_HOST') and
                     os.environ.get('FIREBASE_AUTH_EMULATOR_HOST'), 'Firebase emulators are not configured')
class RemoteEmulatorTests(unittest.TestCase):
    def setUp(self):
        from agent_debug_room import cloud_client
        self.cloud = cloud_client
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        script = """
import {openContext, createRoom} from './cloud/store.mjs';
const firebase = {projectId:'demo-agent-debug-room',apiKey:'emulator-only-key',appId:'emulator-test-app'};
const ctx = await openContext(firebase);
try {
 const result = await createRoom(ctx,{topic:'Remote fixture',context:'original evidence',max_turns:2});
 console.log(JSON.stringify({room_id:result.roomId,invites:result.invites,firebase}));
} finally { await ctx.close(); }
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.created = json.loads(result.stdout.strip().splitlines()[-1])
        self.clients = {}

    def tearDown(self):
        self.temp.cleanup()

    def join(self, role, directory_name=None):
        directory = self.base / (directory_name or role)
        auth = os.environ['FIREBASE_AUTH_EMULATOR_HOST']
        host, port = os.environ['FIRESTORE_EMULATOR_HOST'].rsplit(':', 1)
        value = invitation(room_id=self.created['room_id'], role=role,
                           url='https://example.web.app/r/' + self.created['room_id'],
                           token=self.created['invites'][role], firebase=self.created['firebase'],
                           emulators={'auth': 'http://' + auth,
                                      'firestore': {'host': host, 'port': int(port)}})
        path = self.base / (role + '-invite.json')
        path.write_text(json.dumps(value))
        summary = self.cloud.connect(directory, path)
        self.assertNotIn(value['token'], json.dumps(summary))
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((directory / 'cloud-session.json').stat().st_mode), 0o600)
        client = self.cloud.CloudClient(directory)
        self.clients[role] = client
        return client

    def assert_code(self, code, callback):
        with self.assertRaises(self.cloud.CloudError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_rejected_invitation_leaves_no_connected_profile_and_can_be_retried(self):
        directory = self.base / 'rejected'
        auth = os.environ['FIREBASE_AUTH_EMULATOR_HOST']
        host, port = os.environ['FIRESTORE_EMULATOR_HOST'].rsplit(':', 1)
        value = invitation(room_id=self.created['room_id'], token='x' * 43,
                           url='https://example.web.app/r/' + self.created['room_id'],
                           firebase=self.created['firebase'],
                           emulators={'auth': 'http://' + auth,
                                      'firestore': {'host': host, 'port': int(port)}})
        path = self.base / 'rejected.json'
        path.write_text(json.dumps(value))
        self.assert_code('invalid_invite', lambda: self.cloud.connect(directory, path))
        self.assertFalse((directory / 'cloud-session.json').exists())
        value['token'] = self.created['invites']['server_agent']
        path.write_text(json.dumps(value))
        self.assertEqual(self.cloud.connect(directory, path)['role'], 'server_agent')

    def test_rest_roles_turns_retry_conflict_and_token_refresh(self):
        owner, server, client, viewer = [self.join(role) for role in
                                         ('owner', 'server_agent', 'client_agent', 'viewer')]
        self.assertEqual(len({member.profile['auth']['uid'] for member in self.clients.values()}), 4)
        body = {'content': '  原文 evidence\n', 'client_message_id': 'first'}
        self.assert_code('room_paused', lambda: server.request('/api/agent/messages', body))
        self.assert_code('owner_required', lambda: viewer.request('/api/control', {'action': 'start'}))
        self.assert_code('agent_required', lambda: viewer.request('/api/agent/messages', body))
        owner.request('/api/control', {'action': 'start'})
        self.assert_code('wrong_turn', lambda: client.request('/api/agent/messages', body))
        first = server.request('/api/agent/messages', body)
        self.assertEqual(first['content'], body['content'])
        self.assertEqual(first['id'], 1)
        self.assertEqual(server.request('/api/agent/messages', body), first)
        self.assert_code('message_id_conflict', lambda: server.request('/api/agent/messages', dict(body, content='changed')))
        owner.request('/api/messages', {'content': 'note', 'client_message_id': 'note'})
        client.request('/api/agent/messages', {'content': 'reply', 'client_message_id': 'reply'})
        state = viewer.request('/api/state?after=1')
        self.assertEqual([message['id'] for message in state['messages']], [2, 3])
        self.assertTrue(state['paused'])
        self.assertEqual(state['turns_used'], 2)
        self.assertEqual(owner.request('/api/control', {'action': 'start'})['turns_used'], 0)
        before = server.profile['auth']['uid']
        server.profile['auth']['expires_at'] = 0
        self.assertEqual(server.request('/api/state')['role'], 'server_agent')
        self.assertEqual(server.profile['auth']['uid'], before)
        self.assertGreater(server.profile['auth']['expires_at'], 0)
        for secret in self.created['invites'].values():
            self.assertNotIn(secret, json.dumps(state))

    def test_rest_membership_is_room_scoped_and_invite_is_owner_only(self):
        owner = self.join('owner')
        viewer = self.join('viewer')
        self.assert_code('owner_required', lambda: viewer.request('/api/invite'))
        keys = owner.request('/api/invite')
        self.assertEqual(keys['server_agent_token'], self.created['invites']['server_agent'])
        self.assert_code('unauthorized', lambda: viewer._get('rooms/' + 'z' * 32))

    def test_concurrent_rest_same_id_is_one_message_across_distinct_sessions(self):
        owner = self.join('owner')
        first = self.join('server_agent')
        second = self.join('server_agent', 'second-server')
        self.assertNotEqual(first.profile['auth']['uid'], second.profile['auth']['uid'])
        owner.request('/api/control', {'action': 'start'})
        body = {'content': 'same immutable message', 'client_message_id': 'concurrent-id'}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda client: client.request('/api/agent/messages', body), [first, second]))
        self.assertEqual(results[0], results[1])
        state = owner.request('/api/state')
        self.assertEqual(len(state['messages']), 1)
        self.assertEqual(state['turns_used'], 1)

    def test_commit_permission_race_returns_existing_only_while_still_authorized(self):
        owner = self.join('owner')
        server = self.join('server_agent')
        owner.request('/api/control', {'action': 'start'})
        body = {'content': 'committed during race', 'client_message_id': 'permission-race'}
        first = server.request('/api/agent/messages', body)
        denied = self.cloud.CloudError('unauthorized', 401, 'The room credentials are not authorized')
        with patch.object(server, '_transaction', side_effect=denied):
            self.assertEqual(server.request('/api/agent/messages', body), first)
            self.assert_code('message_id_conflict', lambda: server.request('/api/agent/messages', dict(body, content='changed')))
            self.assert_code('unauthorized', lambda: server.request('/api/agent/messages', dict(body, client_message_id='absent')))
        self.assertEqual(owner.request('/api/state')['turns_used'], 1)

    def test_cli_cloud_profile_uses_saved_role_and_safe_fragment_link(self):
        server = self.join('server_agent')
        def cli(*args):
            return subprocess.run([sys.executable, '-m', 'agent_debug_room.cli', '--state-dir',
                                   str(server.directory), *args], cwd=ROOT, text=True,
                                  capture_output=True, timeout=15)
        state = cli('state')
        self.assertEqual(state.returncode, 0, state.stderr)
        self.assertEqual(json.loads(state.stdout)['role'], 'server_agent')
        link = cli('link')
        self.assertEqual(link.returncode, 0, link.stderr)
        value = json.loads(link.stdout)
        self.assertEqual(value['role'], 'server_agent')
        self.assertIn('#', value['url'])
        self.assertNotIn(server.profile['token'], value['url'].split('#')[0])

    def test_cli_connect_configure_notes_and_reply_use_the_remote_protocol(self):
        owner = self.join('owner')
        server = self.join('server_agent')
        evidence = self.base / 'evidence.txt'
        evidence.write_text('  original 文本\n$(false)', encoding='utf-8')
        def cli(directory, *args):
            result = subprocess.run([sys.executable, '-m', 'agent_debug_room.cli', '--state-dir',
                                     str(directory), *args], cwd=ROOT, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        reconnected = cli(server.directory, 'connect', '--invite-file', str(self.base / 'server_agent-invite.json'))
        self.assertEqual(reconnected['role'], 'server_agent')
        self.assertNotIn(server.profile['token'], json.dumps(reconnected))
        config = cli(owner.directory, 'configure', '--topic', 'CLI remote', '--context-file', str(evidence), '--max-turns', '4')
        self.assertEqual(config['context'], evidence.read_text())
        self.assertEqual(config['max_turns'], 4)
        self.assertFalse(cli(owner.directory, 'start')['paused'])
        reply = cli(server.directory, 'reply', '--file', str(evidence), '--id', 'cli-reply')
        self.assertEqual(reply['role'], 'server')
        self.assertEqual(reply['content'], evidence.read_text())
        self.assertEqual(cli(owner.directory, 'note', '--file', str(evidence), '--id', 'cli-note')['role'], 'human')
        self.assertTrue(cli(owner.directory, 'pause')['paused'])
        exported = cli(owner.directory, 'invite', '--role', 'client_agent')
        self.assertEqual(exported['protocol'], 'agent-debug-room/firebase-v1')
        self.assertEqual(exported['token'], self.created['invites']['client_agent'])
        self.assertNotIn(self.created['invites']['owner'], json.dumps(exported))
        self.assertNotIn('auth', exported)

    def test_realtime_watcher_sends_only_fixed_wakes_and_catches_up_after_restart(self):
        owner = self.join('owner')
        server = self.join('server_agent')
        fake = self.base / 'fake orca'
        log = self.base / 'notifications.jsonl'
        fake.write_text('#!' + sys.executable + '\nimport json,sys\n'
                        + f'with open({str(log)!r},"a") as out: out.write(json.dumps(sys.argv[1:])+"\\n")\n'
                        + 'print(\'{"ok":true}\')\n')
        fake.chmod(0o700)
        def watch():
            return subprocess.run(['node', 'cloud/watch.mjs', '--state-dir', str(server.directory),
                                   '--orca-cli', str(fake), '--run', 'verified-fixture;$(false)',
                                   '--sender', 'verified-terminal', '--once'], cwd=ROOT,
                                  text=True, capture_output=True, timeout=25)
        owner.request('/api/messages', {'content': 'PRIVATE PEER BODY', 'client_message_id': 'pending'})
        paused = watch()
        self.assertEqual(paused.returncode, 0, paused.stderr)
        self.assertFalse(log.exists())
        owner.request('/api/control', {'action': 'start'})
        first = watch()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(log.read_text().splitlines()), 1)
        args = json.loads(log.read_text().splitlines()[0])
        self.assertEqual(args[:4], ['orchestration', 'send', '--to', 'run:verified-fixture;$(false)'])
        self.assertEqual(args[args.index('--from') + 1], 'verified-terminal')
        self.assertNotIn('check', args)
        serialized = ' '.join(args)
        self.assertNotIn('PRIVATE PEER BODY', serialized)
        for token in self.created['invites'].values():
            self.assertNotIn(token, serialized + first.stdout + first.stderr)
        cursor = server.directory / 'cloud-notify-cursor.json'
        self.assertEqual(stat.S_IMODE(cursor.stat().st_mode), 0o600)
        self.assertEqual(watch().returncode, 0)
        self.assertEqual(len(log.read_text().splitlines()), 2)
        server.request('/api/agent/messages', {'content': 'Own answer', 'client_message_id': 'answered'})
        self.assertEqual(watch().returncode, 0)
        self.assertEqual(len(log.read_text().splitlines()), 2)


    def test_realtime_subscription_deduplicates_and_rechecks_pause_turn(self):
        owner = self.join('owner')
        server = self.join('server_agent')
        fake = self.base / 'continuous-orca'
        log = self.base / 'continuous.jsonl'
        fake.write_text('#!' + sys.executable + '\nimport json,sys\n'
                        + f'with open({str(log)!r},"a") as out: out.write(json.dumps(sys.argv[1:])+"\\n")\n'
                        + 'print(\'{"ok":true}\')\n')
        fake.chmod(0o700)
        owner.request('/api/messages', {'content': 'pending', 'client_message_id': 'pending'})
        owner.request('/api/control', {'action': 'start'})
        process = subprocess.Popen(['node', 'cloud/watch.mjs', '--state-dir', str(server.directory),
                                    '--orca-cli', str(fake), '--run', 'fixture-run', '--sender', 'fixture-terminal'],
                                   cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def wait_count(count):
            for _ in range(150):
                if log.exists() and len(log.read_text().splitlines()) >= count:
                    return
                if process.poll() is not None:
                    self.fail('Watcher exited before delivering a notification')
                time.sleep(0.02)
            self.fail('Watcher did not deliver an expected notification')
        try:
            wait_count(1)
            owner.request('/api/config', {'topic': 'Changed metadata'})
            time.sleep(0.1)
            self.assertEqual(len(log.read_text().splitlines()), 1)
            owner.request('/api/control', {'action': 'pause'})
            time.sleep(0.1)
            owner.request('/api/control', {'action': 'start'})
            wait_count(2)
            server.request('/api/agent/messages', {'content': 'answer', 'client_message_id': 'answer'})
            owner.request('/api/messages', {'content': 'not server turn', 'client_message_id': 'late-note'})
            time.sleep(0.15)
            self.assertEqual(len(log.read_text().splitlines()), 2)
        finally:
            process.terminate()
            stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr)

    def test_realtime_failed_native_delivery_never_advances_cursor(self):
        owner = self.join('owner')
        server = self.join('server_agent')
        fake = self.base / 'failed-orca'
        fake.write_text('#!' + sys.executable + '\nimport sys\nprint("{}")\nsys.exit(1)\n')
        fake.chmod(0o700)
        owner.request('/api/messages', {'content': 'pending', 'client_message_id': 'pending'})
        owner.request('/api/control', {'action': 'start'})
        result = subprocess.run(['node', 'cloud/watch.mjs', '--state-dir', str(server.directory),
                                 '--orca-cli', str(fake), '--run', 'fixture', '--sender', 'fixture', '--once'],
                                cwd=ROOT, text=True, capture_output=True, timeout=25)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Room notification pending', result.stderr)
        self.assertFalse((server.directory / 'cloud-notify-cursor.json').exists())


if __name__ == '__main__':
    unittest.main()
