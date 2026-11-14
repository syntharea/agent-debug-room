# Firebase client protocol (v1)

Firebase Hosting + Firestore + anonymous Firebase Auth, on Spark. No privileged
server, service account, Cloud Function, or billing dependency. Anonymous Auth is
automatic: the visitor has no signup or login step. A role key is a bearer
capability, not proof of a person's identity. Sharing it grants that role.

## Paths and fields

All field names below are exact. Firestore timestamps use server timestamps on
creation. Keys are independent 32-byte CSPRNG values, base64url without padding
(43 characters). Room IDs are 20–64 base64url characters (SDK uses 24 random
bytes / 32 characters). A client message ID is 1–200 ASCII letters, digits,
underscore, or hyphen. UUIDs work. The local Python bridge retains its old,
broader ID format.

* `rooms/{roomId}`: `{version: 1, creator_uid: string, created_at: Timestamp,
  topic: string, context: string, max_turns: integer, paused: boolean,
  next_speaker: 'server'|'client', turns_used: integer, seq: integer,
  last_message_id: string, deleting: boolean}`.
  New room: paused=true, next_speaker='server', turns_used=0, seq=0,
  last_message_id='', deleting=false. Topic is nonblank, at most 200 characters;
  context at most 24000; max_turns 1..20. Room becomes read-only exactly seven
  days after created_at. Expiry is derived, not a client-writable field.
* `rooms/{roomId}/secrets/keys`: exactly `{owner: key, viewer: key,
  server_agent: key, client_agent: key}`. All four values must differ. Only a
  currently valid owner member can read this document. Rules can inspect it
  while authorizing others. Other secret paths are denied.
* `rooms/{roomId}/members/{anonymousUid}`:
  exactly `{role: 'owner'|'viewer'|'server_agent'|'client_agent', token: key,
  joined_at: Timestamp}`. An authenticated caller creates only its own member,
  whose role/token must match the room's private keys. Members are immutable;
  use a new isolated anonymous context to join another role. Only that member
  itself or a valid room owner may read it; only owner may list/delete members.
  Every room/message authorization rechecks the member against current keys,
  so rotating a key invalidates all previous memberships for that role.
* `rooms/{roomId}/messages/{client_message_id}`:
  exactly `{seq: integer, role: 'human'|'server'|'client', content: string,
  client_message_id: string, created_at: Timestamp}`. Content is nonblank and
  at most 16000 characters. Messages are immutable. Owner can delete during
  whole-room deletion only. IDs are globally unique within a room. seq 1..100.
* `creation_quotas/{anonymousUid}`:
  exactly `{window_start: Timestamp, count: integer, last_room_id: string}`.
  Only that UID may get its quota. No list/delete. First creation sets count=1,
  window_start=server timestamp. Within 24 hours retain window_start and
  increment count, at most 5. At/after 24h reset count=1 and window_start=server
  timestamp. last_room_id binds exactly one new room to each quota transition.
  Anonymous identities can be replaced; this is a per-identity friction limit,
  not strong anti-abuse. Spark hard quotas are the cost boundary.

No global room listing, discovery, or collection-group access is allowed.
Knowing a room ID alone grants no access. An owner key works in a new browser /
anonymous UID; creator_uid is used for atomic bootstrap only.

## Atomic writes (SDK or Firestore REST transactions)

Create uses one transaction writing four documents: room, secrets/keys,
creator's owner member, and creation quota. Read own quota first. All creation
server timestamps in the transaction resolve to the same request.time. Rules
require all four documents and reject an unaffiliated member bootstrap. The
creator member token must equal keys.owner; creator_uid must equal auth.uid.

Join: create own member with matching role/token and server joined_at. May join
an expired room for read/export/delete, but only owner recovery may join while deleting=true.

Append uses one transaction. Read `messages/{client_message_id}` first (a
missing doc is readable by valid members). If present, same role and exact
content returns that original message without writing; otherwise return
message_id_conflict. A concurrent commit can return PERMISSION_DENIED before
Firestore reports a transaction conflict because messages are immutable. On that
error, re-read the same message under the same normal authorization: return it
only if role/content match, report a conflict if different, and preserve a read
permission failure. Never use an Admin read for this recovery. Read room. Reject deleting, expired, seq>=100. For agents
also reject paused/budget exhaustion and wrong next_speaker. Create message
with seq=room.seq+1 and created_at=server timestamp. Update room seq to that
number and last_message_id to the message doc ID. Human notes leave
turns_used/next_speaker/paused unchanged. Agents increment turns_used by 1,
flip next_speaker, and set paused=(new turns_used >= max_turns). Rules bind the
new message and new head in both directions; two message IDs in one batch
cannot both bind the head. No owner privilege bypasses these append rules.

Configuration (owner): update only topic/context/max_turns/paused; paused must
be `old.paused || old.turns_used >= new.max_turns`. Other fields unchanged.
Control (owner): pause sets paused=true without changing turns_used; start sets
paused=false and resets turns_used to 0 only when previously >= max_turns.
next_speaker remains unchanged. Configuration/control reject expired/deleting.

Rotate a non-owner role (owner): replace only that key in secrets/keys, retaining
all other keys. Owner key rotation is intentionally unsupported; retain it
privately as recovery capability. Rotation rejects expired/deleting rooms.

Delete (owner, including expired): first set deleting=true (irreversible), which
blocks non-owner joins and further room mutations. Delete messages and non-current
members in chunks, then atomically delete current owner member, secrets/keys,
and room. Quota remains. SDK resolves only after children and parent are gone.
No automatic TTL deletion is claimed. If interrupted, an owner may rejoin with the owner key in a new anonymous
context and retry deletion. The application must not start concurrent owner
join/delete flows while cleanup is running.

## Shared JavaScript API

`openContext(firebaseConfig, options={})` creates a separately named app with
inMemoryPersistence, anonymously authenticates, and returns `{app,auth,db,uid,
close()}`. One context owns one room session; no persistent auth is shared across
roles/tabs. Optional emulator shape:
`{emulators:{auth:'http://127.0.0.1:9099',firestore:{host:'127.0.0.1',port:8080}}}`.
Node also recognizes FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST.

`createRoom(ctx,{topic,context,max_turns})` returns
`{roomId,role:'owner',token,invites:{owner,viewer,server_agent,client_agent},session}`.
Default config: topic='Cross-agent debugging', context='', max_turns=20.

`joinRoom(ctx,{roomId,role,token})` returns session. Canonical roles above; input
aliases `server` and `client` are accepted. Session exposes roomId, role, token,
`request(path,body)`, `subscribe(onState,onError)`, `close()` and `deleteRoom()`.
Supplying body means POST; omitted means GET. subscribe returns an unsubscribe
function and emits complete state, using onSnapshot, never a public polling loop.
close unsubscribes and closes its owned context/app.

* GET `/api/state?after=N`: original bridge state shape (title, mode, role,
  topic, context, paused, running:false, next_speaker, turns_used, max_turns,
  participants, messages); plus room_id, created_at, expires_at, expired,
  message_count, message_limit:100, deleting. N is a nonnegative safe integer.
  messages sorted by seq; public messages `{id:seq,role,name,content,created_at}`.
  participants derive last_seen from last agent message (not presence/heartbeat).
* GET `/api/config`: owner only, `{topic,context,max_turns}`.
* POST `/api/config`: owner only, partial config; returns config.
* POST `/api/control`: owner only, `{action:'start'|'pause'}`; returns state.
* POST `/api/messages`: owner human note, `{content,client_message_id}`; returns
  public message. POST `/api/agent/messages`: server_agent or client_agent only.
* GET `/api/invite`: owner only; `{room_id,owner_token,viewer_token,
  server_agent_token,client_agent_token}`. Tokens never belong in logs, query
  strings, published source, or transcripts; invitation URLs use fragments.
* POST `/api/invite`: owner only `{role:'viewer'|'server_agent'|'client_agent'}`;
  rotates that role and returns the same invite shape.

Errors throw Error with `.code`, `.status`, `.data={code,error}`. Existing
codes: invalid_text, invalid_message, invalid_config, invalid_max_turns,
invalid_action, invalid_cursor, unauthorized, owner_required, agent_required,
message_id_conflict, room_paused, wrong_turn, not_found. Cloud-specific:
invalid_invite, invalid_message_id, room_expired, room_full, room_deleting,
creation_limit, unavailable, resource_exhausted, internal_error. Technical
messages are English; UI translates codes. SDK/Rules errors never include keys.

The REST adapter authenticates with a normal anonymous Firebase ID token and
uses the same optimistic transaction strategy as the Web SDK. Production rejects
the separate built-in `beginTransaction` API for this client identity, even though
the emulator accepts it. Read documents with `batchGet`, retain each existing
document's `updateTime`, then submit all writes in one atomic `commit` without a
server transaction ID. The room update uses `currentDocument.updateTime` and the
new message uses `currentDocument.exists=false`. A version conflict retries the
reads and commit, with a bounded retry count. If a concurrent immutable-message
create instead reports permission denied, re-read that message under the same
normal Rules: return it only when the role and exact content match; different
content is `message_id_conflict`, and lost read permission remains unauthorized.
These preconditions preserve the room/message atomic invariants without changing
the schema or relaxing Rules. No Admin or publisher OAuth bypass is used.
