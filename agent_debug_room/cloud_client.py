"""One-shot Firebase REST operations using ordinary anonymous Auth and room rules."""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .cli import private_dir, private_write

PROTOCOL = 'agent-debug-room/firebase-v1'
ROLES = ('owner', 'viewer', 'server_agent', 'client_agent')
NAMES = {'human': 'Host', 'server': 'Server agent', 'client': 'Client agent'}


class CloudError(RuntimeError):
    def __init__(self, code, status, message, retryable=False):
        self.code, self.status, self.retryable = code, status, retryable
        self.data = {'code': code, 'error': message}
        super().__init__(f'{code}: {message}')


def _fail(code, message, status=400):
    raise CloudError(code, status, message)


def _loopback(host):
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_invite(value):
    """Validate untrusted invitations before selecting any network destination."""
    try:
        if (not isinstance(value, dict) or value.get('protocol') != PROTOCOL
                or not re.fullmatch(r'[A-Za-z0-9_-]{20,64}', value.get('room_id', ''))
                or value.get('role') not in ROLES
                or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value.get('token', ''))):
            raise ValueError()
        config = value['firebase']
        if (not isinstance(config, dict)
                or not re.fullmatch(r'[a-z0-9][a-z0-9-]{4,62}', config.get('projectId', ''))
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', config.get('apiKey', ''))
                or not isinstance(config.get('appId'), str) or not 1 <= len(config['appId']) <= 300):
            raise ValueError()
        url = urllib.parse.urlsplit(value['url'])
        if (not url.hostname or url.username or url.password or url.query or url.fragment
                or url.path != '/r/' + value['room_id']
                or (url.scheme != 'https' and not (url.scheme == 'http' and
                        value.get('emulators') and _loopback(url.hostname)))):
            raise ValueError()
        if 'emulators' in value:
            emulators = value['emulators']
            auth = urllib.parse.urlsplit(emulators['auth'])
            firestore = emulators['firestore']
            if (auth.scheme != 'http' or not _loopback(auth.hostname)
                    or auth.username or auth.password or auth.path not in ('', '/')
                    or auth.query or auth.fragment or not auth.port
                    or not _loopback(firestore['host']) or type(firestore['port']) is not int
                    or not 1 <= firestore['port'] <= 65535):
                raise ValueError()
        return {key: value[key] for key in ('protocol', 'url', 'room_id', 'role', 'token', 'firebase', 'emulators')
                if key in value}
    except (KeyError, TypeError, ValueError, AttributeError):
        _fail('invalid_invite', 'Invalid Firebase room invitation')


def _encode(value):
    if isinstance(value, bool):
        return {'booleanValue': value}
    if isinstance(value, int):
        return {'integerValue': str(value)}
    if isinstance(value, str):
        return {'stringValue': value}
    raise ValueError('Unsupported Firestore field type')


def _decode(document):
    result = {}
    for name, value in document.get('fields', {}).items():
        if 'integerValue' in value:
            result[name] = int(value['integerValue'])
        elif 'booleanValue' in value:
            result[name] = value['booleanValue']
        elif 'timestampValue' in value:
            result[name] = value['timestampValue']
        elif 'stringValue' in value:
            result[name] = value['stringValue']
    return result


def _http(url, body=None, token=None, form=False):
    headers = {'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = ((urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode())
            if body is not None else None)
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            with error:
                detail = json.load(error).get('error', {})
                status = detail.get('status', '') if isinstance(detail, dict) else ''
        except (ValueError, OSError):
            status = ''
        if status in ('ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS') or error.code == 409:
            raise CloudError('unavailable', 409, 'The transaction conflicted; retry', True) from None
        if error.code == 404:
            raise CloudError('not_found', 404, 'Room or document not found') from None
        if error.code in (401, 403):
            raise CloudError('unauthorized', 401, 'The room credentials are not authorized') from None
        if error.code == 429 or status == 'RESOURCE_EXHAUSTED':
            raise CloudError('resource_exhausted', 429, 'The Firebase project quota is exhausted') from None
        if error.code >= 500:
            raise CloudError('unavailable', 503, 'Firebase is temporarily unavailable', True) from None
        raise CloudError('unavailable', error.code, 'Firebase rejected the request') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CloudError('unavailable', 503, 'Could not reach Firebase', True) from None


class CloudClient:
    def __init__(self, directory, profile=None):
        self.directory = Path(directory)
        self.path = self.directory / 'cloud-session.json'
        self.connected = profile is None
        self.profile = profile if profile is not None else json.loads(self.path.read_text(encoding='utf-8'))
        validate_invite(self.profile)
        self.room_path = 'rooms/' + self.profile['room_id']
        project = self.profile['firebase']['projectId']
        self.documents = f'projects/{project}/databases/(default)/documents'
        emulators = self.profile.get('emulators')
        if emulators:
            host = emulators['firestore']['host']
            if ':' in host:
                host = '[' + host + ']'
            self.firestore_origin = f'http://{host}:{emulators["firestore"]["port"]}'
            self.auth_origin = emulators['auth'].rstrip('/') + '/identitytoolkit.googleapis.com'
            self.refresh_origin = emulators['auth'].rstrip('/') + '/securetoken.googleapis.com'
        else:
            self.firestore_origin = 'https://firestore.googleapis.com'
            self.auth_origin = 'https://identitytoolkit.googleapis.com'
            self.refresh_origin = 'https://securetoken.googleapis.com'
        self.base = self.firestore_origin + '/v1/' + self.documents

    def _save(self):
        private_write(self.path, json.dumps(self.profile, ensure_ascii=False) + '\n')
        self.connected = True

    def _auth(self, refresh=False):
        key = urllib.parse.quote(self.profile['firebase']['apiKey'], safe='')
        if refresh:
            result = _http(self.refresh_origin + '/v1/token?key=' + key,
                           {'grant_type': 'refresh_token', 'refresh_token': self.profile['auth']['refreshToken']},
                           form=True)
            auth = {'uid': result['user_id'], 'idToken': result['id_token'],
                    'refreshToken': result['refresh_token'], 'expires_at': time.time() + int(result['expires_in'])}
            if auth['uid'] != self.profile['auth']['uid']:
                _fail('unauthorized', 'The Firebase session identity changed', 401)
        else:
            result = _http(self.auth_origin + '/v1/accounts:signUp?key=' + key, {'returnSecureToken': True})
            auth = {'uid': result['localId'], 'idToken': result['idToken'],
                    'refreshToken': result['refreshToken'], 'expires_at': time.time() + int(result['expiresIn'])}
        self.profile['auth'] = auth
        if refresh and self.connected:
            self._save()

    def _fire(self, path='', body=None):
        if self.profile['auth']['expires_at'] <= time.time() + 60:
            self._auth(refresh=True)
        try:
            return _http(self.base + path, body, self.profile['auth']['idToken'])
        except CloudError as error:
            if error.code != 'unauthorized':
                raise
            self._auth(refresh=True)
            return _http(self.base + path, body, self.profile['auth']['idToken'])

    def _get(self, path, read_versions=None, missing=False):
        try:
            if read_versions is not None:
                result = self._fire(':batchGet', {'documents': [self.documents + '/' + path]})
                if 'found' in result[0]:
                    document = result[0]['found']
                    read_versions[path] = document['updateTime']
                    return _decode(document)
                read_versions[path] = None
                if missing:
                    return None
                _fail('not_found', 'Room or document not found', 404)
            return _decode(self._fire('/' + path))
        except CloudError as error:
            if missing and error.code == 'not_found':
                return None
            raise

    def _write(self, path, fields, *, create=False, timestamp=None):
        write = {'update': {'name': self.documents + '/' + path,
                            'fields': {key: _encode(value) for key, value in fields.items()}},
                 'currentDocument': {'exists': not create}}
        if not create:
            write['updateMask'] = {'fieldPaths': list(fields)}
        if timestamp:
            write['updateTransforms'] = [{'fieldPath': timestamp, 'setToServerValue': 'REQUEST_TIME'}]
        return write

    def join(self):
        path = self.room_path + '/members/' + self.profile['auth']['uid']
        self._fire(':commit', {'writes': [self._write(path,
                    {'role': self.profile['role'], 'token': self.profile['token']},
                    create=True, timestamp='joined_at')]})
        self._get(self.room_path)

    def _public_message(self, message):
        return {'id': message['seq'], 'role': message['role'], 'name': NAMES[message['role']],
                'content': message['content'], 'created_at': message['created_at']}

    def _mutable(self, room):
        if room['deleting']:
            _fail('room_deleting', 'The room is being deleted', 409)
        created = datetime.fromisoformat(room['created_at'].replace('Z', '+00:00'))
        if datetime.now(timezone.utc) >= created + timedelta(days=7):
            _fail('room_expired', 'The room has expired and is read-only', 409)

    def state(self, after=0):
        room = self._get(self.room_path)
        response = self._fire('/' + self.room_path + ':runQuery', {'structuredQuery': {
            'from': [{'collectionId': 'messages'}],
            'where': {'fieldFilter': {'field': {'fieldPath': 'seq'}, 'op': 'LESS_THAN_OR_EQUAL',
                                      'value': _encode(room['seq'])}},
            'orderBy': [{'field': {'fieldPath': 'seq'}, 'direction': 'ASCENDING'}], 'limit': 100}})
        messages = [self._public_message(_decode(item['document'])) for item in response if 'document' in item]
        participants = {role: {'last_seen': next((message['created_at'] for message in reversed(messages)
                                               if message['role'] == role), None)} for role in ('server', 'client')}
        created = datetime.fromisoformat(room['created_at'].replace('Z', '+00:00'))
        expiry = created + timedelta(days=7)
        expired = datetime.now(timezone.utc) >= expiry
        return {'title': 'Agent Debug Room', 'mode': 'agent_bridge', 'role': self.profile['role'],
                'topic': room['topic'], 'context': room['context'],
                'paused': room['paused'] or expired or room['deleting'], 'running': False,
                'next_speaker': room['next_speaker'], 'turns_used': room['turns_used'], 'max_turns': room['max_turns'],
                'participants': participants, 'messages': [message for message in messages if message['id'] > after],
                'room_id': self.profile['room_id'], 'created_at': room['created_at'],
                'expires_at': expiry.isoformat().replace('+00:00', 'Z'), 'expired': expired,
                'message_count': room['seq'], 'message_limit': 100, 'deleting': room['deleting']}

    def _transaction(self, operation):
        # Like the Web SDK, use optimistic document versions and one atomic commit.
        # Built-in beginTransaction is rejected for ordinary Firebase ID tokens.
        for attempt in range(4):
            read_versions = {}
            try:
                writes, result = operation(read_versions)
                for write in writes:
                    path = write['update']['name'][len(self.documents) + 1:]
                    version = read_versions[path]
                    write['currentDocument'] = ({'updateTime': version} if version is not None
                                                else {'exists': False})
                if writes:
                    self._fire(':commit', {'writes': writes})
                return result
            except CloudError as error:
                if not error.retryable or attempt == 3:
                    raise
                time.sleep(0.05 * (attempt + 1))
        _fail('unavailable', 'The transaction could not complete', 503)

    def _append(self, role, body):
        if not isinstance(body, dict):
            _fail('invalid_message', 'Invalid message format')
        content, message_id = body.get('content'), body.get('client_message_id')
        if not isinstance(content, str) or not content.strip() or len(content) > 16000:
            _fail('invalid_text', 'content has invalid content or length')
        if not isinstance(message_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', message_id):
            _fail('invalid_message_id', 'client_message_id must be 1–200 URL-safe ASCII characters')
        path = self.room_path + '/messages/' + message_id
        def append(read_versions):
            existing = self._get(path, read_versions, missing=True)
            if existing:
                if existing['role'] != role or existing['content'] != content:
                    _fail('message_id_conflict', 'This message ID has different content or role', 409)
                return [], self._public_message(existing)
            room = self._get(self.room_path, read_versions)
            self._mutable(room)
            if room['seq'] >= 100:
                _fail('room_full', 'The room has reached its message limit', 409)
            changes = {'seq': room['seq'] + 1, 'last_message_id': message_id}
            if role != 'human':
                if room['paused'] or room['turns_used'] >= room['max_turns']:
                    _fail('room_paused', 'The room is paused; wait for the owner to resume', 409)
                if room['next_speaker'] != role:
                    _fail('wrong_turn', 'Wait for the other agent to speak', 409)
                turns = room['turns_used'] + 1
                changes.update(turns_used=turns, next_speaker='client' if role == 'server' else 'server',
                               paused=turns >= room['max_turns'])
            message = {'seq': changes['seq'], 'role': role, 'content': content, 'client_message_id': message_id}
            return [self._write(path, message, create=True, timestamp='created_at'),
                    self._write(self.room_path, changes)], None
        try:
            result = self._transaction(append)
        except CloudError as error:
            if error.code not in ('unauthorized', 'unavailable'):
                raise
            # A concurrent create can surface as PERMISSION_DENIED for an immutable doc.
            # Recover only through a fresh read still authorized by the room rules.
            try:
                existing = self._get(path, missing=True)
            except CloudError:
                raise error from None
            if not existing:
                raise
            if existing['role'] != role or existing['content'] != content:
                _fail('message_id_conflict', 'This message ID has different content or role', 409)
            return self._public_message(existing)
        return result if result is not None else self._public_message(self._get(path))

    def request(self, path, body=None):
        parsed = urllib.parse.urlsplit(path)
        route = parsed.path
        if parsed.scheme or parsed.netloc or parsed.fragment:
            _fail('not_found', 'Endpoint not found', 404)
        if body is None and route == '/api/state':
            after = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('after', ['0'])
            if (len(after) != 1 or not after[0].isascii() or not after[0].isdigit()
                    or len(after[0]) > 16 or int(after[0]) > 9007199254740991):
                _fail('invalid_cursor', 'after must be a non-negative safe integer')
            return self.state(int(after[0]))
        if route == '/api/agent/messages' and body is not None:
            if self.profile['role'] not in ('server_agent', 'client_agent'):
                _fail('agent_required', 'This endpoint requires an agent token', 403)
            return self._append(self.profile['role'].removesuffix('_agent'), body)
        if route not in ('/api/config', '/api/control', '/api/messages', '/api/invite'):
            _fail('not_found', 'Endpoint not found', 404)
        if self.profile['role'] != 'owner':
            _fail('owner_required', 'This operation requires the owner token', 403)
        if route == '/api/messages' and body is not None:
            return self._append('human', body)
        if route == '/api/invite' and body is None:
            keys = self._get(self.room_path + '/secrets/keys')
            return {'room_id': self.profile['room_id'], **{role + '_token': keys[role] for role in ROLES}}
        if route == '/api/config' and body is None:
            room = self._get(self.room_path)
            return {key: room[key] for key in ('topic', 'context', 'max_turns')}
        if route == '/api/config' and body is not None:
            if not isinstance(body, dict) or set(body) - {'topic', 'context', 'max_turns'}:
                _fail('invalid_config', 'Configuration only supports topic, context and max_turns')
            for key, limit in (('topic', 200), ('context', 24000)):
                if key in body and (not isinstance(body[key], str) or len(body[key]) > limit
                                    or (key == 'topic' and not body[key].strip())):
                    _fail('invalid_text', key + ' has invalid content or length')
            if 'max_turns' in body and (type(body['max_turns']) is not int or not 1 <= body['max_turns'] <= 20):
                _fail('invalid_max_turns', 'max_turns must be an integer between 1 and 20')
        elif route == '/api/control' and body is not None:
            if not isinstance(body, dict) or body.get('action') not in ('start', 'pause'):
                _fail('invalid_action', 'Action must be start or pause')
        else:
            _fail('not_found', 'Endpoint not found', 404)
        def update(read_versions):
            room = self._get(self.room_path, read_versions)
            self._mutable(room)
            if route == '/api/config':
                changes = dict(body)
                changes['paused'] = room['paused'] or room['turns_used'] >= body.get('max_turns', room['max_turns'])
            else:
                changes = {'paused': body['action'] == 'pause'}
                if body['action'] == 'start' and room['turns_used'] >= room['max_turns']:
                    changes['turns_used'] = 0
            return [self._write(self.room_path, changes)], None
        self._transaction(update)
        return self.request('/api/config') if route == '/api/config' else self.state()

    def link(self):
        return {'role': self.profile['role'], 'url': self.profile['url'] + '#' + urllib.parse.urlencode(
                {'role': self.profile['role'], 'token': self.profile['token']})}

    def invitation(self, role='client_agent'):
        keys = self.request('/api/invite')
        return {**validate_invite(self.profile), 'role': role, 'token': keys[role + '_token']}


def connect(directory, invite_file):
    directory = private_dir(directory)
    try:
        invite = validate_invite(json.loads(Path(invite_file).read_text(encoding='utf-8')))
    except (ValueError, OSError):
        _fail('invalid_invite', 'Could not read a valid invitation JSON file')
    saved = directory / 'cloud-session.json'
    if any((directory / name).exists() for name in ('credentials.json', 'config.json', 'transcript.sqlite3', 'room-url.txt')):
        _fail('invalid_invite', 'This state directory already contains a local room; use a new private directory')
    if saved.exists():
        previous = CloudClient(directory)
        if validate_invite(previous.profile) != invite:
            _fail('invalid_invite', 'This state directory already belongs to another invitation; use a new directory')
        previous.request('/api/state')
        return {'room_id': invite['room_id'], 'role': invite['role'], 'url': invite['url']}
    client = CloudClient(directory, dict(invite))
    client._auth()
    try:
        client.join()
    except CloudError as error:
        if error.code == 'unauthorized':
            _fail('invalid_invite', 'The room invitation is invalid or revoked', 401)
        raise
    client._save()
    return {'room_id': invite['room_id'], 'role': invite['role'], 'url': invite['url']}


def request(directory, path, body=None):
    return CloudClient(directory).request(path, body)
