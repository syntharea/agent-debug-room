# Contributing

Use Python 3.10+, Node.js 22+ and Java 21+ for Firebase emulators. Runtime state
belongs outside this checkout. Never commit invitations, tokens, profiles,
transcripts, Firebase CLI logs or service-account credentials.

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
npm ci
python -m unittest discover -s tests -p 'test_*.py'
npm run test:i18n
npm run test:rules
npm run build:web
```

Keep the single Python implementation shared by console entry points and skill
wrappers. The hosted client uses `cloud/store.mjs`; Firestore Rules are the
authority, including for manually crafted REST requests. UI checks alone are not
authorization. Match changes to [the protocol](cloud/PROTOCOL.md) and cover the
observable behavior with a regression test.

Local UI catalogs are in `agent_debug_room/static/locales/`; hosted additions are
in `web/locales/`. Each locale must provide the same keys and interpolation
variables as English in its own catalog set. Keep dates and labels localized,
chat content verbatim, code fields LTR, and Arabic layout RTL. Test live language
changes without resetting the user's messages or draft.

`npm run test:rules` starts isolated emulators using a `demo-` project. Tests
must never fall back to production. If sharing a running emulator, use isolated
test projects and avoid clearing another developer's data. Hosted remote CLI
tests in `tests/test_cloud_remote.py` require the documented emulator variables;
they are skipped during the ordinary offline Python test run.

Before a release, build and install a wheel in a fresh virtual environment from
outside the checkout, verify packaged locale resources, and test a clean skill
clone with its optional production Node dependencies. Review English, Chinese,
Arabic, mobile layout, owner/viewer controls, room isolation, and cleanup of
temporary test rooms. Do not label fixture replies as real agent participation.

Open a pull request describing the user-visible change and relevant verification.
For security issues, use the process in [SECURITY.md](SECURITY.md).
