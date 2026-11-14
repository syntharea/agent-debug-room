# Open-source and internationalization implementation plan

**Goal:** Publish Agent Debug Room as a complete open-source project under `syntharea/agent-debug-room`, with an installable agent skill and an international interface.

**User requirements:** Improve the existing skill into an open-source project and publish it to SynthArea; add multilingual i18n suitable for global users.

**Implementation choices:** English is the default. Initial UI locales: en, zh-CN, zh-TW, ja, ko, es, fr, de, pt-BR, ar. Arabic uses RTL. Chat content remains verbatim.

**Architecture:** One Python-standard-library implementation in `agent_debug_room/`, shared by pip CLI entry points and the three thin `scripts/` wrappers used by skill installations. Static HTML/CSS/JS plus centralized locale catalogs; no frontend build dependency. Root SKILL.md remains directly installable. Existing rooms and runtime data are never copied or modified.

## Interfaces and ownership

- Backend engineer: `agent_debug_room/{server,cli,notify,tunnel}.py`, `tests/{test_server,test_helpers,test_api}.py`. Keep the existing `error` field as a string, HTTP statuses and permission semantics; add stable lowercase `code`. Technical API/CLI messages become English; compatibility does not promise the old Chinese wording. Preserve auth, idempotency, alternation, pause, persistence, CSP and token isolation. Serve `/i18n.mjs`, `/favicon.svg`, and safe `/locales/<locale>.json` from packaged static resources.
- Frontend engineer: `agent_debug_room/static/**`, `tests/test_i18n.mjs`. Localize all UI, attributes, invitations, errors, dynamic labels, dates and transcript export. Persist explicit locale choice, detect browser locale, fallback to English. Use textContent and preserve raw discussion content.
- Coordinator: README/README.zh-CN, SKILL/references, pyproject, LICENSE, contribution/security/release docs, CI, package/install smoke test and publication. No duplication of the implementation for the skill.

API error codes: `invalid_text`, `unauthorized`, `invalid_config`, `invalid_max_turns`, `invalid_message`, `message_id_conflict`, `room_paused`, `wrong_turn`, `invalid_action`, `unsupported_transfer_encoding`, `unsupported_content_type`, `content_length_required`, `invalid_content_length`, `request_too_large`, `invalid_json`, `invalid_cursor`, `agent_required`, `owner_required`, `not_found`, `internal_error`. Error JSON retains `error` and adds `code`. Frontend keys use `api.<code>`.

## Tasks and acceptance

- [x] Import only clean verified source into a separate repository; inherited 10 backend and 8 helper tests pass before changes.
- [ ] Restore the thin package's existing behavior with English messages, stable errors and safe static locale resources; retain regression coverage.
- [ ] Implement 10 locales with key completeness, interpolation/fallback/detection tests, persistent switch and RTL.
- [ ] Add minimal project metadata, MIT license, English-first onboarding and Chinese docs, troubleshooting, protocol and contribution guidance.
- [ ] Build wheel/sdist; install wheel and skill from a clean copy and run the documented room flow. Verify packaged static assets, real viewer permissions, deduplication and pause.
- [ ] Independent review, browser validation in English/Chinese/Arabic at desktop/mobile sizes, and temporary public tunnel check. Fixtures are never claimed as real peer participation.
- [ ] Inspect public files for credentials, transcripts, machine paths or historical session IDs; exclude caches, runtime and build artifacts.
- [ ] Create public repository, push reviewed source, publish v0.1.0 and source archives, verify remote commit and CI. Refresh local Codex skill from the released source without touching current room state.

## Review focus

Clean installation must use packaged assets, not source-directory fallbacks. Language changes must not reset messages, roles, cursor or raw content. RTL must retain readable token/code fields. Late responses must not restore logged-out sessions. Notifiers must bind to verified original sessions, only send wakes, and never consume inboxes or start substitute models. Publication is already authorized; no unrelated production changes.

## Hosted application extension

The final product also provides free, registration-free private multi-room
Firebase hosting. See [the final design](../design/firebase-app.md) and
[the exact cloud protocol](../../cloud/PROTOCOL.md). Spark, automatic anonymous
sessions and Rules replace the earlier server-only scope. Users explicitly
selected private role invitations and authorized autonomous implementation and
publication. No additional approval gate remains.

Evidence completed before release: baseline local/helper tests, 10-locale UI
tests, real Firestore/Auth emulator permission and transaction tests, REST
profile/CLI and realtime notifier tests, independent source review, initial
public Hosting deployment and independent multi-browser privacy/locale checks.
Unicode character limits were corrected consistently in Rules and UI after
non-BMP boundary tests reproduced a mismatch. Final packaging, installed-client
public message flow, remote GitHub/CI and release checks finish the task.
