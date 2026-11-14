#!/usr/bin/env python3
"""Private HTTP message bridge for two existing agents and human observers."""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import urllib.parse


NAMES = {'server': '当前助手', 'client': '对方 Agent', 'human': '主持人'}
TOKEN_ROLES = ('owner', 'viewer', 'server_agent', 'client_agent')
DEFAULT_CONFIG = {'topic': '跨 Agent 联调', 'context': '', 'max_turns': 20}
SECURITY_HEADERS = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; "
                             "connect-src 'self'; img-src 'self' data:; font-src 'self'; "
                             "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
}


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle, ensure_ascii=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def validate_text(value, name, maximum, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise APIError(400, f'{name} 的内容或长度无效')
    return value


class RoomState:
    def __init__(self, state_dir):
        self.directory = Path(state_dir)
        if not self.directory.is_absolute():
            raise ValueError('state_dir must be an absolute private directory')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        credentials_path = self.directory / 'credentials.json'
        self.credentials = (json.loads(credentials_path.read_text(encoding='utf-8'))
                            if credentials_path.exists() else {})
        for role in TOKEN_ROLES:
            self.credentials.setdefault(role + '_token', secrets.token_urlsafe(32))
        if (any(not isinstance(self.credentials.get(role + '_token'), str)
                or len(self.credentials[role + '_token']) < 43 for role in TOKEN_ROLES)
                or len(set(self.credentials.values())) != 4):
            raise ValueError('Invalid private room credentials')
        atomic_json(credentials_path, self.credentials)
        self.config_path = self.directory / 'config.json'
        previous = (json.loads(self.config_path.read_text(encoding='utf-8'))
                    if self.config_path.exists() else {})
        self.config = {key: previous.get(key, default) for key, default in DEFAULT_CONFIG.items()}
        atomic_json(self.config_path, self.config)
        self.lock = threading.RLock()
        database_path = self.directory / 'transcript.sqlite3'
        self.db = sqlite3.connect(database_path, check_same_thread=False)
        os.chmod(database_path, 0o600)
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
                created_at TEXT NOT NULL, client_message_id TEXT UNIQUE, request_hash TEXT
            );
            CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        metadata = dict(self.db.execute('SELECT key, value FROM room_meta'))
        self.next_speaker = metadata.get('next_speaker', 'server')
        self.turns_used = int(metadata.get('turns_used', 0))
        self.paused = True
        self.participants = {'server': {'last_seen': None}, 'client': {'last_seen': None}}

    def authenticate(self, authorization):
        if authorization and authorization.startswith('Bearer '):
            for role in TOKEN_ROLES:
                if hmac.compare_digest(authorization[7:].encode(), self.credentials[role + '_token'].encode()):
                    return role
        raise APIError(401, '需要有效的房间访问令牌')

    def redact(self, text):
        for token in self.credentials.values():
            text = text.replace(token, '[已隐藏]')
        return text

    def messages(self, after=0):
        rows = self.db.execute('SELECT id, role, name, content, created_at FROM messages '
                               'WHERE id > ? ORDER BY id', (after,)).fetchall()
        return [dict(zip(('id', 'role', 'name', 'content', 'created_at'), row)) for row in rows]

    def state(self, role='owner', after=0):
        with self.lock:
            if role in ('server_agent', 'client_agent'):
                self.participants[role.removesuffix('_agent')]['last_seen'] = timestamp()
            return {'title': 'Agent 对话室', 'mode': 'agent_bridge', 'role': role,
                    'topic': self.redact(self.config['topic']), 'context': self.redact(self.config['context']),
                    'paused': self.paused, 'running': False, 'next_speaker': self.next_speaker,
                    'turns_used': self.turns_used, 'max_turns': self.config['max_turns'],
                    'participants': {name: dict(value) for name, value in self.participants.items()},
                    'messages': self.messages(after)}

    def public_config(self):
        with self.lock:
            return {key: self.redact(value) if isinstance(value, str) else value
                    for key, value in self.config.items()}

    def configure(self, body):
        if not isinstance(body, dict) or set(body) - set(DEFAULT_CONFIG):
            raise APIError(400, '配置仅支持 topic、context 和 max_turns')
        with self.lock:
            result = dict(self.config)
            for key, limit in (('topic', 2000), ('context', 32000)):
                if key in body:
                    result[key] = validate_text(body[key], key, limit, allow_empty=(key == 'context'))
            if 'max_turns' in body:
                value = body['max_turns']
                if type(value) is not int or not 1 <= value <= 20:
                    raise APIError(400, 'max_turns 必须是 1 到 20 之间的整数')
                result['max_turns'] = value
            atomic_json(self.config_path, result)
            self.config = result
            if self.turns_used >= result['max_turns']:
                self.paused = True
            return self.public_config()

    def save_progress(self):
        self.db.executemany('INSERT OR REPLACE INTO room_meta (key, value) VALUES (?, ?)',
                            [('next_speaker', self.next_speaker), ('turns_used', str(self.turns_used))])
        self.db.commit()

    def post_message(self, role, body):
        if not isinstance(body, dict):
            raise APIError(400, '消息格式无效')
        content = validate_text(body.get('content'), '消息', 16000)
        client_id = validate_text(body.get('client_message_id'), '消息 ID', 200)
        digest = hashlib.sha256(content.encode()).hexdigest()
        with self.lock:
            previous = self.db.execute('SELECT id, role, request_hash FROM messages WHERE client_message_id = ?',
                                       (client_id,)).fetchone()
            if previous:
                if previous[1] != role or previous[2] != digest:
                    raise APIError(409, '该消息 ID 已被用于其他角色或不同内容')
                return self.messages(previous[0] - 1)[0]
            if role != 'human':
                if self.paused or self.turns_used >= self.config['max_turns']:
                    raise APIError(409, '房间已暂停，请等待主持人继续')
                if role != self.next_speaker:
                    raise APIError(409, '请等待另一位 Agent 发言')
            cursor = self.db.execute('INSERT INTO messages '
                                     '(role, name, content, created_at, client_message_id, request_hash) '
                                     'VALUES (?, ?, ?, ?, ?, ?)',
                                     (role, NAMES[role], self.redact(content), timestamp(), client_id, digest))
            if role != 'human':
                self.participants[role]['last_seen'] = timestamp()
                self.turns_used += 1
                self.next_speaker = 'client' if role == 'server' else 'server'
                self.paused = self.turns_used >= self.config['max_turns']
            self.save_progress()
            return self.messages(cursor.lastrowid - 1)[0]

    def control(self, body):
        if not isinstance(body, dict) or body.get('action') not in ('start', 'pause'):
            raise APIError(400, '操作必须是 start 或 pause')
        with self.lock:
            self.paused = body['action'] == 'pause'
            if not self.paused and self.turns_used >= self.config['max_turns']:
                self.turns_used = 0
                self.save_progress()
            return self.state()

    def close(self):
        with self.lock:
            self.db.close()


class RoomServer(ThreadingHTTPServer):
    daemon_threads = True

    def server_close(self):
        self.room.close()
        super().server_close()

    def handle_error(self, request, client_address):
        pass


class RoomHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def respond(self, status, content, content_type='application/json; charset=utf-8'):
        if not isinstance(content, bytes):
            content = json.dumps(content, ensure_ascii=False).encode()
        self.send_response(status)
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def read_json(self):
        if self.headers.get('Transfer-Encoding'):
            raise APIError(400, '不支持分块请求')
        if self.headers.get_content_type() != 'application/json':
            raise APIError(400, '请使用 application/json')
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            raise APIError(411, '需要 Content-Length') from None
        if length < 0:
            raise APIError(400, '请求长度无效')
        if length > 65536:
            raise APIError(413, '请求体不得超过 64 KiB')
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError()
            return json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, 'JSON 格式无效') from None

    def dispatch(self, method):
        try:
            url = urllib.parse.urlsplit(self.path)
            path = url.path
            room = self.server.room
            if method == 'GET' and path == '/healthz':
                self.respond(200, {'ok': True})
                return
            if path.startswith('/api/'):
                role = room.authenticate(self.headers.get('Authorization'))
                if method == 'GET' and path == '/api/state':
                    after = urllib.parse.parse_qs(url.query, keep_blank_values=True).get('after', ['0'])
                    if len(after) != 1 or not after[0].isascii() or not after[0].isdigit() or len(after[0]) > 18:
                        raise APIError(400, 'after 必须是非负整数')
                    self.respond(200, room.state(role, int(after[0])))
                    return
                if method == 'POST' and path == '/api/agent/messages':
                    if role not in ('server_agent', 'client_agent'):
                        raise APIError(403, '此接口仅限 Agent')
                    self.respond(200, room.post_message(role.removesuffix('_agent'), self.read_json()))
                    return
                known = (method, path) in {('GET', '/api/config'), ('GET', '/api/invite'),
                                             ('POST', '/api/config'), ('POST', '/api/messages'),
                                             ('POST', '/api/control')}
                if not known:
                    raise APIError(404, '未找到接口')
                if role != 'owner':
                    raise APIError(403, '此操作仅限主持人')
                if method == 'GET':
                    result = (room.public_config() if path == '/api/config'
                              else {key: value for key, value in room.credentials.items() if key != 'owner_token'})
                else:
                    body = self.read_json()
                    if path == '/api/config':
                        result = room.configure(body)
                    elif path == '/api/messages':
                        result = room.post_message('human', body)
                    else:
                        result = room.control(body)
                self.respond(200, result)
                return
            static = {'/': ('index.html', 'text/html; charset=utf-8'),
                      '/index.html': ('index.html', 'text/html; charset=utf-8'),
                      '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                      '/style.css': ('style.css', 'text/css; charset=utf-8')}
            if method == 'GET' and path in static:
                name, content_type = static[path]
                try:
                    content = (self.server.static_dir / name).read_bytes()
                except FileNotFoundError:
                    raise APIError(404, '未找到页面') from None
                self.respond(200, content, content_type)
                return
            raise APIError(404, '未找到页面')
        except APIError as exc:
            self.respond(exc.status, {'error': exc.message})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.respond(500, {'error': '服务暂时无法处理该请求'})

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')


def create_server(host, port, state_dir, static_dir=None):
    room = RoomState(state_dir)
    try:
        server = RoomServer((host, port), RoomHandler)
    except Exception:
        room.close()
        raise
    server.room = room
    server.static_dir = Path(static_dir) if static_dir else Path(__file__).with_name('static')
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=58371, type=int)
    parser.add_argument('--state-dir', type=Path, required=True)
    args = parser.parse_args()
    if not args.state_dir.is_absolute():
        parser.error('--state-dir must be an absolute private directory')
    server = create_server(args.host, args.port, args.state_dir)
    print(f'Agent bridge listening on http://{args.host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
