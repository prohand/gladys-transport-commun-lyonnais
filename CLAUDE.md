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
src/devices/pollSchedule.js   drops the poll ticks inside the configured interval
src/devices/refreshLoop.js    the container's own ticker over the created devices
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

## What goes public

Everything in this repository is public: the files, the commit messages, the
branch names and the pull request titles and bodies. The repository owner's own
stops are not — a real stop, station or park & ride picked because it is the one
next to somebody's home says where that somebody lives, and a branch name is as
permanent as a merge commit once the pull request is merged.

So never carry a personal example into anything pushed here. Examples in the
documentation, in tests and in fixtures use network landmarks everybody in Lyon
shares (`Bellecour`, `Gorge de Loup`, `Part-Dieu`); the same holds for branch
names, commit messages and pull requests, which describe the change rather than
the stop that revealed it. When a bug report names a real stop, reproduce it
with a landmark and write the landmark down.

## Data Grand Lyon authentication

Two things cause the 401 everybody hits, and both are handled in
`src/api/grandlyon.js` — do not "simplify" them away:

- the web service does not accept the **GrandLyon Connect** password used to
  sign in on the portal, only the platform-specific password set on
  <https://data.grandlyon.com/onegeo-login/fr/profile/>. Every message about
  refused credentials must say so;
- the retired portal endpoint (`data.grandlyon.com/fr/datapusher/ws/rdata`)
  redirects to `download.data.grandlyon.com/ws/rdata`, and `fetch` drops the
  Authorization header on a cross-origin redirect. The client therefore
  follows redirects itself (`redirect: 'manual'`) and only replays the
  credentials on the same origin or on an https `grandlyon.com` host.

Two more things about the web service, both fixed in `src/api/grandlyon.js`
after they reached users as bugs:

- filtering is `field=<attribute>&value=<value>` (or the Django-flavoured
  `<attribute>__eq=`, `__gt`, `__in`...). The JSON `filter` parameter the
  integration used to send is **not** implemented: the service ignores it and
  answers with the whole layer, so callers send `equalityParams()` and re-check
  the records they get back;
- `<base>/all.json` (without a layer) is the index of everything the service
  publishes. `fetchLayer` reads it when every known name of a dataset answers
  404, so a rename is picked up by itself; the 404 message is only reached when
  the catalogue has nothing either, and it then lists the closest published
  names.

A dataset that vanishes is not always a rename: `tcl_sytral.tclparcrelais` was
**split** into `tclparcrelaistr` (temps réel, the occupancy) and
`tclparcrelaisst` (statique, the facilities), and a matcher that only stripped
`_2_0_0`-style version suffixes read that as "retired for good". The candidate
lists in `src/api/tcl.js` name the current layer first, and
`matchPublishedLayers` also follows a published name that merely _extends_ a
known one. Column names moved with the split too (`nbplacesdispo` ->
`nb_tot_place_dispo`): every parser reads through `pick`, add the new spelling
rather than replacing the old one.

The two halves of that split are read **together**, not one as a fallback for
the other: the real-time layer only carries the facilities SYTRAL counts live,
so listing it alone hides the rest of the network — the reported "the park &
ride list is incomplete". `listParkAndRideFacilities` merges the static
inventory (22 facilities) with the live counts, survives the loss of either
layer, and only errors when both fail. A facility with no live count is listed
with `?` free spaces rather than dropped.

Timeouts are per kind of read (`REQUEST_TIMEOUT_MS`, `BULK_TIMEOUT_MS`,
`PROBE_TIMEOUT_MS`): the stop directory is a multi-megabyte download and does
not fit in the budget that is generous for a filtered read. A manifest action
that can trigger a bulk read needs a `timeout_seconds` larger than the budget,
otherwise Gladys gives up before the client does.

A third trap is documentation-only, but every message about the account should
keep pointing at the way out: the profile page offers a _change your password_
form that asks for an old password, and an account created through GrandLyon
Connect never had one. The password is set through the platform's own
forgotten-password link, reachable after logging out of the portal.

## The manifest is validated by the store

`gladys-assistant-integration.json` is checked by the store indexer, and a
rejected manifest blocks publication. The rules that bite most often:

- `description.en` / `description.fr`: **10-100 characters**. The long
  explanation belongs in the `intro` section, not here.
- Field `type` must be one of `string`, `number`, `boolean`, `select`,
  `multi_select`, `secret`, `oauth2`, `account_link`, `section`. There is no
  `text` and no `password` type: use `string` and `secret`.
- `placeholder` is only allowed on `string`, `number` and `secret` fields, and
  like every user-visible string it must be a `{ en, fr }` object, not a bare
  string.
- `section` fields are presentational: no `required`, `default` or
  `placeholder`, and their key must never appear in `DEFAULT_CONFIG`.
- Any `default` declared in `config_schema` must equal the matching value in
  `DEFAULT_CONFIG` (`src/config.js`).
- `categories` requires `gladys_version >= 4.86.0`, and its keys come from a
  **closed** vocabulary (`INTEGRATION_CATALOG_CATEGORIES` in the core):
  `climate`, `lighting`, `energy`, `security`, `multimedia`, `appliances`,
  `environment`, `protocols`, `network`, `notifications`, `assistants`,
  `services`. There is no `transport` — an unknown key is silently dropped at
  indexing time and the integration ends up filed under nothing. This one lives
  in `environment`, the shelf the spec defines as carrying the "open-data
  daily-life feeds" (air quality, fuel prices, water restrictions).

`test/manifest.test.js` enforces all of the above plus the code/manifest
consistency (every action has a handler and vice versa). When you change the
manifest, change that test with it.

## Publishing devices

`poll_frequency` is in **milliseconds** and must be one of the values the core
scheduler knows (`DEVICE_POLL_FREQUENCIES`: 1000, 2000, 10000, 15000, 30000,
60000). The core validates the whole `POST /discovered_device` batch and
answers `400` on the first offender, so a single device published with `60`
(seconds) empties the **entire** Discovery screen while the container logs a
cheerful "Publishing 1 device(s)". That was a real bug: publish through
`gladysPollFrequency` (src/config.js), never the raw configured interval.

Gladys has nothing slower than one tick a minute, while the configuration
accepts intervals up to an hour. The gap is closed by `dueForRead`
(src/devices/pollSchedule.js), which drops the ticks arriving inside the
configured interval — that is what keeps "refresh the park & ride every 5
minutes" from reading the platform every minute. A blueprint therefore exposes
`pollIntervalMs(config)` next to `onPoll`, and `pollDevice` is the entry point
`index.js` wires to `gladys.onPoll`.

`poll_frequency` alone schedules nothing. The core inserts a device in
`devicesByPollFrequency` only when its row also carries `should_poll: true`,
and it reads that flag once, from the discovery payload the Discovery screen
posts to `POST /device` at creation. A device published without it is created,
displayed, and never polled — no tick, no state, no error: the reported
"aucune valeur enregistrée lorsque l'on ajoute un appareil", with the
integration logging nothing at all because nothing ever asked it for anything.
Every blueprint therefore publishes `should_poll: true` next to
`poll_frequency`.

That flag is also unfixable from the container once the device exists:
re-publishing a discovery only upserts the `params` and the feature
`supported_options` of an already-created device, and the Discovery screen only
offers its "Update" button when the published FEATURES differ — a flag is not a
feature. A device created by the broken version would have stayed empty until
the user deleted and re-added it. That is what `src/devices/refreshLoop.js` is
for: the container ticks over `gladys.devices` (the SDK's list of the devices
the user actually created) at the fastest frequency the core itself would use,
so those devices fill in on their own after an update. Both paths go through
`dueForRead`, so the upstream feed is still read once per configured interval
no matter how many tickers ask for it.

The same validation applies to every feature: `category`, `type` and `unit`
must come from the standard Gladys lists, and the device and feature
`external_id`s must carry the `ext:<selector>:` prefix (`gladys.externalIds`
builds them).

`min` and `max` are optional in the SDK types and NOT NULL in the core's
`t_device_feature`, so a feature published without them fails the batch with
`422 — t_device_feature.min cannot be null`, and the device never reaches the
Discovery screen. That bit the text features, where a range means nothing: the
user-visible symptom was "Fonctionnalité « Next departure line » — valeur
minimum : champ obligatoire non renseigné". Every feature therefore declares a
range — its real gauge bounds when numeric, `TEXT_FEATURE_RANGE`
(src/devices/featureRange.js, the 0/0 the core's own UI stores) when the state
is a string.

## Releasing

Version bumps and tags are handled by `.github/workflows/release.yml`, which
calls `build.yml` to publish the multi-arch image to ghcr.io. That workflow
bumps `package.json` and rewrites the manifest `version` and `docker_image`
tag itself — do not bump them by hand in a feature branch.

`build.yml` failing with `denied: permission_denied: write_package` is not a
missing permission in the YAML: the job already declares `packages: write`, and
the run log confirms it under "GITHUB_TOKEN Permissions". It means the ghcr
package exists without being attached to this repository — that is what a first
push from a laptop, or from a repository since renamed or deleted, leaves
behind, and an unattached package belongs to the account, not to the repository
whose `GITHUB_TOKEN` is asking. The one-off fix is in the GitHub UI (delete the
package and let the workflow recreate it, or add the repository under "Manage
Actions access" with the Write role); the `org.opencontainers.image.source`
label the build sets is what keeps it from happening again, because ghcr
attaches the package to the repository that label names.
