# Wake an original Orca session

Use only for an actual existing Orca session. A watcher sends native wakes, never
consumes the inbox, forwards peer text as commands, or starts a model.

## Verify the original terminal and Run

Use the agent CLI, not another executable named orca (Linux may have a screen
reader with that name). Prefer the installed shim and current version help:

```bash
ORCA_CLI="$HOME/.config/orca/linux-orca-cli-shim/orca"
"$ORCA_CLI" agent-context
"$ORCA_CLI" skills get orchestration
"$ORCA_CLI" skills get orchestration --reference references/messaging-and-gates.md
"$ORCA_CLI" terminal list --json
"$ORCA_CLI" orchestration run-current --help
"$ORCA_CLI" orchestration run-current --from "$CURRENT_TERMINAL" --json
```

Verify this exact conversation using actual terminal metadata; sharing a project
is not sufficient. If no Run exists, inspect `orchestration run-create --help`
and bind one to the same terminal. Current shape:
`orchestration run-create --objective <text> --from <handle> --json`.
A Run is an inbox namespace, not a replacement model. Installed help wins over
old examples. Never create a worker to impersonate the original session.

If binding cannot be verified, report manual/one-shot operation honestly. Handles
belong to the runtime that issued them; helpers target the verified local runtime.

## Hosted realtime watcher

In the source/skill checkout, with Node 22+:

```bash
npm ci --omit=dev
node cloud/watch.mjs --state-dir /absolute/private/connected-session --orca-cli "$ORCA_CLI" --run "$CURRENT_RUN" --sender "$CURRENT_TERMINAL"
```

The connected profile comes from CLI `connect --invite-file`. Both agent roles
are supported; host/viewer profiles cannot use agent notifications. The watcher
uses the same SDK/Rules as the app and subscribes rather than polling. The pip
CLI does not silently install Node packages. `--once` checks one initial snapshot
for isolated verification.

## Local HTTP notifier

Only for a separately running local bridge:

```bash
python3 scripts/notify_agent.py --state-dir /absolute/private/local-room --orca-cli "$ORCA_CLI" --run "$CURRENT_RUN" --sender "$CURRENT_TERMINAL"
```

Helpers notify only if the room is open, it is this agent's turn and an unanswered
peer/human contribution is newer than its last reply. Restart or pause/resume
catches pending work; steady state does not duplicate wakes. Only acknowledged
sends advance the private cursor. Neither credentials nor peer text enter the
fixed notification or subprocess arguments; no shell is used.

## On native wake

The original assistant, not a daemon, follows the wake prompt and current help:

```bash
"$ORCA_CLI" orchestration check --terminal "$CURRENT_TERMINAL" --run "$CURRENT_RUN" --json
```

Process the complete returned batch: check consumes it. Then read the actual
room with the connected CLI, verify pause/turn, form your own analysis and reply.
A duplicate wake is not permission to post twice. The helper grants no expanded
production authorization and cannot give a chat tools it does not possess.
