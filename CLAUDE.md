# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

## What this project is

An **external Gladys Assistant integration** for Lyon's public transport
network (TCL). It runs as a Docker container next to a Gladys instance, talks
to the Gladys host through the official SDK
(`@gladysassistant/integration-sdk`), and publishes one **read-only** device
per watched transit stop, Vélo'v station and park & ride facility.

Not affiliated with SYTRAL Mobilités, Keolis Lyon or JCDecaux. Data comes from
Data Grand Lyon (HTTP Basic auth, free account) and the open Vélo'v GBFS feed.

## Commands

```bash
npm ci                 # install (the tests need the SDK, they fail without it)
npm test               # node --test, no framework, no network access
npm run lint           # eslint
npm run format         # prettier --write .
npm run format:check   # what CI checks
```

Always run `npm test`, `npm run lint` and `npm run format:check` before
committing — CI (`.github/workflows/ci.yml`) runs the three.

## Layout

```
index.js                      SDK wiring only: handlers, connect, status
src/config.js                 defaults, type coercion, watch-list mini-syntax
src/api/grandlyon.js          HTTP Basic client for the Data Grand Lyon rdata API
src/api/tcl.js                departures + park & ride, per-cycle cache
src/api/velov.js              GBFS index/information/status, per-cycle cache
src/devices/index.js          dynamic device registry + manifest actions
src/devices/transitStop.js    one device per watched stop
src/devices/velovStation.js   one device per watched Vélo'v station
src/devices/parkAndRide.js    one device per watched P+R facility
test/                         node:test suites, with a fake Gladys SDK in test/helpers
docs/en.md, docs/fr.md        user-facing documentation (re-hosted by Gladys)
gladys-assistant-integration.json   the store manifest
cover.png                     store cover image (800x534)
```

Keep the separation: `index.js` holds no transport logic, `src/api/` only reads
feeds, `src/devices/` only turns a feed into features.

## Conventions

- ES modules (`"type": "module"`), Node >= 20, no runtime dependency besides
  the SDK. Do not add dependencies without a strong reason.
- Prettier decides formatting; ESLint decides the rest. Never hand-format.
- Comments in this repo explain **why**, in full sentences, in English. Match
  that density — the file headers are a deliberate part of the style.
- Every user-visible string in the manifest and in action results is
  bilingual (`{ en, fr }`).
- Devices are read-only: no blueprint implements `onSetValue`.
- The device list is derived from the configuration, never static:
  `buildDiscoveredDevices` and `findBlueprintByDevice` rebuild the blueprints
  from `config.watched` on every call.

## The manifest is validated by the store

`gladys-assistant-integration.json` is checked by the store indexer, and a
rejected manifest blocks publication. The rules that bite most often:

- `description.en` / `description.fr`: **10-100 characters**. The long
  explanation belongs in the `intro` section, not here.
- Field `type` must be one of `string`, `number`, `boolean`, `select`,
  `multi_select`, `secret`, `oauth2`, `account_link`, `section`. There is no
  `text` and no `password` type: use `string` and `secret`.
- `placeholder` is only allowed on `string`, `number` and `secret` fields.
- `section` fields are presentational: no `required`, `default` or
  `placeholder`, and their key must never appear in `DEFAULT_CONFIG`.
- Any `default` declared in `config_schema` must equal the matching value in
  `DEFAULT_CONFIG` (`src/config.js`).
- `categories` requires `gladys_version >= 4.86.0`.

`test/manifest.test.js` enforces all of the above plus the code/manifest
consistency (every action has a handler and vice versa). When you change the
manifest, change that test with it.

## Releasing

Version bumps and tags are handled by `.github/workflows/release.yml`, which
calls `build.yml` to publish the multi-arch image to ghcr.io. That workflow
bumps `package.json` and rewrites the manifest `version` and `docker_image`
tag itself — do not bump them by hand in a feature branch.
