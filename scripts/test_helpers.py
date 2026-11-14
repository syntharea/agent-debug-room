"""Isolated real-HTTP helper tests; fake external CLIs never contact another agent."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', ROOT / 'assets/bridge/server.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.state = self.base / 'private'
        self.http = backend.create_server('127.0.0.1', 0, self.state)
        self.thread = threading.Thread(target=self.http.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.tokens = json.loads((self.state / 'credentials.json').read_text())

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/room.py'),
                                 '--state-dir', str(self.state), '--room-url', self.url, *args],
                                text=True, capture_output=True, timeout=5)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        return result

    def request(self, path, body=None, role='owner'):
        request = urllib.request.Request(self.url + path,
                   data=json.dumps(body).encode() if body is not None else None,
                   headers={'Authorization': 'Bearer ' + self.tokens[role + '_token'],
                            'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def post(self, role, message_id, content='local test fixture'):
        return self.request('/api/agent/messages',
                            {'content': content, 'client_message_id': message_id}, role + '_agent')

    def test_file_messages_roles_configuration_and_retry(self):
        evidence = self.base / 'evidence.txt'
        marker = self.base / 'should-not-exist'
        evidence.write_text(f'真实证据\n$(touch {marker}); `false`', encoding='utf-8')
        result = self.cli('configure', '--topic', '联调', '--context-file', str(evidence), '--max-turns', '4')
        self.assertEqual(result, {'topic': '联调', 'context': evidence.read_text(), 'max_turns': 4})
        self.assertEqual(self.cli('state')['role'], 'server_agent')
        self.cli('start')
        first = self.cli('reply', '--file', str(evidence), '--id', 'one')
        retry = self.cli('reply', '--file', str(evidence), '--id', 'one')
        self.assertEqual(first, retry)
        self.assertEqual(first['role'], 'server')
        self.assertEqual(first['content'], evidence.read_text())
        self.assertNotEqual(self.cli('reply', '--file', str(evidence), '--id', 'out-of-turn', ok=False).returncode, 0)
        self.assertEqual(self.cli('reply', '--role', 'client', '--file', str(evidence), '--id', 'two')['role'], 'client')
        self.assertEqual(self.cli('note', '--file', str(evidence), '--id', 'note')['role'], 'human')
        state = self.cli('state', '--role', 'viewer')
        self.assertEqual(state['turns_used'], 2)
        self.assertEqual(len(state['messages']), 3)
        self.cli('pause')
        self.assertNotEqual(self.cli('reply', '--file', str(evidence), '--id', 'paused', ok=False).returncode, 0)
        self.assertFalse(marker.exists())

    def test_share_links_and_client_invitation_keep_owner_private(self):
        viewer = self.cli('link', '--role', 'viewer')
        owner = self.cli('link', '--role', 'owner')
        self.assertEqual(viewer['url'], self.url + '/#token=' + self.tokens['viewer_token'])
        self.assertEqual(owner['url'], self.url + '/#token=' + self.tokens['owner_token'])
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/room.py'), '--state-dir',
                   str(self.state), '--room-url', self.url, 'invite'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.tokens['client_agent_token'], result.stdout)
        for key in ('owner_token', 'viewer_token', 'server_agent_token'):
            self.assertNotIn(self.tokens[key], result.stdout)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)

    def fake_orca(self, fail=False):
        path = self.base / 'fake orca'
        log = self.base / 'orca.jsonl'
        path.write_text('#!' + sys.executable + '\nimport json, sys\n'
                        f'with open({str(log)!r}, "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                        + ('print("{}")\nsys.exit(1)\n' if fail else 'print(\'{"ok": true}\')\n'))
        path.chmod(0o700)
        return path, log

    def notifier(self, cli, *extra):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/notify_agent.py'),
                    '--state-dir', str(self.state), '--room-url', self.url, '--orca-cli', str(cli),
                    '--run', 'current-fixture-run;$(false)', '--sender', 'current-fixture-terminal',
                    '--once', *extra], text=True, capture_output=True, timeout=5)

    def test_notifier_pause_resume_restart_catchup_and_own_reply(self):
        fake, log = self.fake_orca()
        self.request('/api/messages', {'content': 'peer text $(touch /tmp/never); --danger',
                                      'client_message_id': 'human'})
        self.assertEqual(self.notifier(fake).returncode, 0)
        self.assertFalse(log.exists())
        self.request('/api/control', {'action': 'start'})
        self.assertEqual(self.notifier(fake).returncode, 0)
        args = json.loads(log.read_text().splitlines()[0])
        self.assertEqual(args[:4], ['orchestration', 'send', '--to', 'run:current-fixture-run;$(false)'])
        self.assertEqual(args[args.index('--from') + 1], 'current-fixture-terminal')
        self.assertNotIn('peer text', ' '.join(args))
        self.assertNotIn('check', args)
        cursor = self.state / 'notify-cursor.json'
        self.assertEqual(stat.S_IMODE(cursor.stat().st_mode), 0o600)
        self.request('/api/control', {'action': 'pause'})
        self.notifier(fake)
        self.assertEqual(len(log.read_text().splitlines()), 1)
        self.request('/api/control', {'action': 'start'})
        self.notifier(fake)
        self.assertEqual(len(log.read_text().splitlines()), 2)
        self.post('server', 'server')
        self.notifier(fake)
        self.assertEqual(len(log.read_text().splitlines()), 2)
        self.post('client', 'client')
        self.notifier(fake)
        self.assertEqual(len(log.read_text().splitlines()), 3)
        # A restarted notifier catches up an acknowledged but unanswered peer post.
        self.notifier(fake)
        self.assertEqual(len(log.read_text().splitlines()), 4)

    def test_notifier_failed_delivery_does_not_advance_cursor(self):
        fake, log = self.fake_orca(fail=True)
        self.request('/api/messages', {'content': 'pending', 'client_message_id': 'pending'})
        self.request('/api/control', {'action': 'start'})
        result = self.notifier(fake)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('room notification pending: RuntimeError', result.stdout)
        self.assertEqual(len(log.read_text().splitlines()), 1)
        self.assertFalse((self.state / 'notify-cursor.json').exists())

    def test_continuous_notifier_deduplicates_until_pause_resume(self):
        fake, log = self.fake_orca()
        self.request('/api/messages', {'content': 'pending', 'client_message_id': 'pending'})
        self.request('/api/control', {'action': 'start'})
        process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/notify_agent.py'),
                    '--state-dir', str(self.state), '--room-url', self.url, '--orca-cli', str(fake),
                    '--run', 'local-fixture-run', '--sender', 'local-fixture-terminal',
                    '--interval', '0.02'], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def wait_for(count):
            for _ in range(100):
                if log.exists() and len(log.read_text().splitlines()) >= count:
                    return
                time.sleep(0.01)
            self.fail('notifier did not deliver pending room notification')
        try:
            wait_for(1)
            time.sleep(0.1)
            self.assertEqual(len(log.read_text().splitlines()), 1)
            self.request('/api/control', {'action': 'pause'})
            time.sleep(0.1)
            self.assertEqual(len(log.read_text().splitlines()), 1)
            self.request('/api/control', {'action': 'start'})
            wait_for(2)
            self.post('server', 'server-answer')
            time.sleep(0.1)
            self.assertEqual(len(log.read_text().splitlines()), 2)
        finally:
            process.terminate()
            process.communicate(timeout=3)

    def test_tunnel_passes_arguments_without_shell_and_records_url(self):
        fake = self.base / 'fake cloudflared'
        log = self.base / 'tunnel-args.json'
        fake.write_text('#!' + sys.executable + '\nimport json, sys, time\n'
                        f'open({str(log)!r}, "w").write(json.dumps(sys.argv[1:]))\n'
                        'print("https://local-fixture.trycloudflare.com", flush=True)\n'
                        'time.sleep(0.15)\n')
        fake.chmod(0o700)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/run_tunnel.py'),
                     '--state-dir', str(self.state), '--room-url', self.url, '--cloudflared', str(fake),
                     '--', '--edge-bind-address', 'fixture;$(false)'],
                     text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(log.read_text())
        self.assertIn(self.url, args)
        self.assertEqual(args[-2:], ['--edge-bind-address', 'fixture;$(false)'])
        self.assertIn('http2', args)
        # The URL remains the last observed address; it is not a liveness claim.
        url = self.state / 'tunnel-url.txt'
        self.assertEqual(url.read_text().strip(), 'https://local-fixture.trycloudflare.com')
        self.assertEqual(stat.S_IMODE(url.stat().st_mode), 0o600)

    def test_terminating_foreground_tunnel_also_stops_its_child(self):
        fake = self.base / 'fake-cloudflared'
        child_done = self.base / 'child-done'
        fake.write_text('#!' + sys.executable + '\nimport signal, sys, time\n'
                        f'def stop(*args):\n    open({str(child_done)!r}, "w").write("stopped")\n    sys.exit(0)\n'
                        'signal.signal(signal.SIGTERM, stop)\n'
                        'print("https://local-fixture.trycloudflare.com", flush=True)\n'
                        'while True: time.sleep(0.05)\n')
        fake.chmod(0o700)
        process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/run_tunnel.py'),
                     '--state-dir', str(self.state), '--room-url', self.url, '--cloudflared', str(fake)],
                     text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            for _ in range(100):
                if (self.state / 'tunnel-url.txt').exists():
                    break
                time.sleep(0.01)
            self.assertTrue((self.state / 'tunnel-url.txt').exists())
            process.terminate()
            process.wait(timeout=3)
            self.assertTrue(child_done.exists(), 'wrapper left its own cloudflared child running')
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            process.communicate(timeout=3)


class ServeTests(unittest.TestCase):
    def test_frontend_serve_uses_loopback_and_retains_private_state(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / 'room'
            process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/room.py'),
                           '--state-dir', str(state), 'serve', '--port', '0'],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(100):
                    if (state / 'room-url.txt').exists() or process.poll() is not None:
                        break
                    time.sleep(0.02)
                self.assertIsNone(process.poll(), 'serve exited before creating its private address file')
                url = (state / 'room-url.txt').read_text().strip()
                self.assertTrue(url.startswith('http://127.0.0.1:'))
                with urllib.request.urlopen(url + '/healthz', timeout=2) as response:
                    self.assertEqual(json.load(response), {'ok': True})
                with urllib.request.urlopen(url + '/', timeout=2) as response:
                    self.assertIn('text/html', response.headers['Content-Type'])
                for name in ('credentials.json', 'config.json', 'transcript.sqlite3', 'room-url.txt'):
                    self.assertEqual(stat.S_IMODE((state / name).stat().st_mode), 0o600)
            finally:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
