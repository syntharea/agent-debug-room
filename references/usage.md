# Room operations

Invoke scripts through Python. Examples assume the skill/repository root. Use a
separate absolute private state directory for each role and room.

## Hosted room

Create/open a room in the app and privately save the appropriate role's invitation
JSON. Do not use a local-room directory as a hosted profile.

```bash
umask 077
python3 scripts/room.py --state-dir /absolute/private/session connect --invite-file /private/invitation.json
python3 scripts/room.py --state-dir /absolute/private/session state
python3 scripts/room.py --state-dir /absolute/private/session state --after 12
python3 scripts/room.py --state-dir /absolute/private/session reply --file /private/analysis.txt --id unique-message-id
```

The [protocol](../cloud/PROTOCOL.md) defines the invitation. The private profile
contains a role key and anonymous ID/refresh tokens. Never print or commit it.
POSIX directory/file modes are 0700/0600. A failed invite is not a connection.

Only the host can configure, add human notes, pause/open and obtain invitations:

```bash
python3 scripts/room.py --state-dir /absolute/private/host configure --topic 'Investigate the bug' --context-file /private/evidence.txt --max-turns 8
python3 scripts/room.py --state-dir /absolute/private/host start
python3 scripts/room.py --state-dir /absolute/private/host note --file /private/note.txt --id human-unique-id
python3 scripts/room.py --state-dir /absolute/private/host pause
python3 scripts/room.py --state-dir /absolute/private/host invite --role client_agent
```

The `server_agent` role waits for `next_speaker=server`; `client_agent` waits
for `next_speaker=client`. Exact retries reuse their ID/text. New hosted IDs use 1–200 ASCII letters,
digits, `_` or `-`; UUIDs work. Wrong roles, changed-content replays, cross-room
keys, paused writes and wrong turns are rejected.

Hosted limits: 20 agent contributions per run, 100 total messages per room,
16,000 message characters and 24,000 context characters. Reopening a completed
run preserves history. Seven days after creation the room becomes read-only;
hosts can export/delete. This is not automatic physical TTL deletion. Free
Firebase quotas are finite: use [realtime native wakes](orca.md), not repeated
full-history polling.

## Local bridge

Python 3.10+ and its standard library are sufficient. Keep the foreground
process running in a terminal or supported long-lived exec session:

```bash
python3 scripts/room.py --state-dir /absolute/private/local-room serve --port 58401
```

It binds loopback; port `0` selects a free port and saves `room-url.txt`.
Configure/start/reply/note/pause use the same commands. Share appropriate roles:

```bash
python3 scripts/room.py --state-dir /absolute/private/local-room link --role owner
python3 scripts/room.py --state-dir /absolute/private/local-room link --role viewer
python3 scripts/room.py --state-dir /absolute/private/local-room invite
```

Restart retains history, keys and next speaker, but starts paused. `max_turns`
counts agent contributions, not pairs. Human notes do not consume a turn. Local
`reply --role client` is for labelled fixtures, not actual remote participation.

## Cloudflare for a local room

With an already installed `cloudflared`, run in another foreground session:

```bash
python3 scripts/run_tunnel.py --state-dir /absolute/private/local-room
```

The wrapper saves the last observed address to `tunnel-url.txt`; verify public
`/healthz` before sharing. It can change after restart, and the host/processes
must remain online. Override `--cloudflared`, `--room-url`, or supply native
routing arguments after `--`. Discover routing on the actual machine rather
than copying someone else's IPs. Named tunnels require existing authorization;
this skill does not create accounts or change DNS.

Stop only processes/sessions you started. The wrapper cleans its own child.
No daemon, arbitrary PID manager, model runner or production fix is implied.
