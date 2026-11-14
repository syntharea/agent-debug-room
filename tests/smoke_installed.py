"""Run with a clean wheel-install interpreter, from outside the source checkout."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import agent_debug_room


checkout = Path(__file__).resolve().parents[1]
if Path(agent_debug_room.__file__).resolve().is_relative_to(checkout):
    raise SystemExit('Smoke test must import the installed wheel, not the checkout')

with tempfile.TemporaryDirectory() as temp:
    state = Path(temp) / 'room'
    process = subprocess.Popen(
        [sys.executable, '-m', 'agent_debug_room', '--state-dir', str(state), 'serve', '--port', '0'],
        cwd=temp, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={key: value for key, value in os.environ.items() if key != 'PYTHONPATH'},
    )
    try:
        for _ in range(150):
            if (state / 'room-url.txt').exists() or process.poll() is not None:
                break
            time.sleep(0.02)
        if process.poll() is not None:
            raise AssertionError('Installed server exited: ' + process.stderr.read())
        origin = (state / 'room-url.txt').read_text().strip()
        credentials = json.loads((state / 'credentials.json').read_text())

        def api(path, role=None, body=None):
            headers = {'Content-Type': 'application/json'}
            if role:
                headers['Authorization'] = 'Bearer ' + credentials[role + '_token']
            request = urllib.request.Request(
                origin + path, headers=headers,
                data=json.dumps(body).encode() if body is not None else None,
            )
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as response:
                return response.code, response.read()

        for asset in ['/', '/app.js', '/i18n.mjs', '/style.css', '/favicon.svg']:
            status, content = api(asset)
            assert status == 200 and content, asset
        for locale in ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ar']:
            status, content = api('/locales/' + locale + '.json')
            assert status == 200 and isinstance(json.loads(content), dict), locale
        assert api('/api/state')[0] == 401
        assert api('/api/control', 'viewer', {'action': 'start'})[0] == 403
        assert api('/api/control', 'owner', {'action': 'start'})[0] == 200
        for role, identifier in [('server_agent', 'installed-a'), ('client_agent', 'installed-b')]:
            status, _ = api('/api/agent/messages', role, {'content': 'Explicit installation fixture', 'client_message_id': identifier})
            assert status == 200
        status, data = api('/api/state', 'viewer')
        assert status == 200 and len(json.loads(data)['messages']) == 2
        print(json.dumps({'installed_wheel': True, 'packaged_assets': True, 'local_role_flow': 'pass'}))
    finally:
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=5)
