# Transports en Commun Lyonnais — Gladys Assistant integration

An external [Gladys Assistant](https://gladysassistant.com) integration for
Lyon's public transport network (TCL):

- **Next departures** at the transit stops you watch;
- **Vélo'v** bike and free-dock availability, in real time;
- **Park & ride (P+R)** free spaces, in real time.

Built on the official
[integration-template-js](https://github.com/GladysAssistant/integration-template-js).

> Unofficial integration, not affiliated with SYTRAL Mobilités, Keolis Lyon or
> JCDecaux. Data © Métropole de Lyon, under the licences of the datasets linked
> below.

## User documentation

The user-facing guide is in [`docs/en.md`](docs/en.md) (English) and
[`docs/fr.md`](docs/fr.md) (French). Gladys re-hosts it and links to it from
the Configuration screen. Start there if you just want to use the integration.

## Data sources

| Domain      | Source                                                                                | Account needed |
| ----------- | ------------------------------------------------------------------------------------- | -------------- |
| Departures  | `tcl_sytral.tclpassagearret*` on [Data Grand Lyon](https://data.grandlyon.com)        | Yes (free)     |
| Park & ride | `tcl_sytral.tclparcrelais*` on Data Grand Lyon                                        | Yes (free)     |
| Vélo'v      | [GBFS feed](https://gbfs.org/documentation/reference/) (Métropole de Lyon / JCDecaux) | No             |

Data Grand Lyon is read over HTTP Basic auth with the account the user fills in
the configuration — with the password set on
[the data platform profile](https://data.grandlyon.com/onegeo-login/fr/profile/),
which is **not** the GrandLyon Connect password the portal is browsed with.
The web service answers the retired portal endpoint with a cross-host redirect,
so `src/api/grandlyon.js` follows redirects itself (`fetch` strips the
Authorization header across origins, which turns a valid account into a 401).

The `*` in the table is the layer version suffix: the platform republishes a
dataset under a new name (`tcl_sytral.tclarret` -> `tcl_sytral.tclarret_2_0_0`)
and retires the previous one, which reaches the user as a bare HTTP 404 on a
working account. `src/api/tcl.js` therefore declares every name it knows,
newest first, and `fetchLayer` keeps the one that answers.

The Vélo'v GBFS feed is open; both GBFS v2 and v3 payload shapes are supported,
so `velov_gbfs_url` can point at either published version.

## Architecture

```
index.js                  SDK wiring only: handlers, connect, status
src/config.js             defaults, type coercion, watch-list mini-syntax
src/api/grandlyon.js      HTTP Basic client for the Data Grand Lyon rdata API
src/api/tcl.js            departures + park & ride, with a per-cycle cache
src/api/velov.js          GBFS index/information/status, with a per-cycle cache
src/devices/index.js      dynamic registry (devices come from the config) + actions
src/devices/transitStop.js    one device per watched stop
src/devices/velovStation.js   one device per watched Vélo'v station
src/devices/parkAndRide.js    one device per watched P+R facility
```

Unlike the template, the device list is **not static**: it is derived from the
configuration, so `buildDiscoveredDevices` and `findBlueprintByDevice` rebuild
the blueprints from `config.watched` on every call.

Every device is read-only — no blueprint implements `onSetValue`.

### Polling

Gladys drives the refresh: each device is published with its own
`poll_frequency` (in seconds) and the core calls `onPoll(device)` at that
interval. The three sources get three independent settings, because they do not
move at the same speed:

| Config key                     | Default | Range     | Drives                 |
| ------------------------------ | ------- | --------- | ---------------------- |
| `departures_poll_frequency`    | 60 s    | 30–3600 s | Transit stop devices   |
| `velov_poll_frequency`         | 120 s   | 30–3600 s | Vélo'v station devices |
| `park_and_ride_poll_frequency` | 300 s   | 30–3600 s | Park & ride devices    |

Values are clamped in `normalizeConfig` so a hand-edited configuration can
never hammer the open data platforms.

The whole-network feeds (Vélo'v GBFS, park & ride layer) are fetched once and
memoized for 20 s — shorter than the shortest allowed poll frequency, which
collapses the burst of `onPoll` calls Gladys fires for devices sharing an
interval into a single HTTP request.

## Development

```bash
npm install
npm test           # node --test, no network access needed
npm run lint
npm run format
```

The tests stub `fetch`, so they exercise the real HTTP client and parsers
against recorded payload shapes (including the v2/v3 GBFS variants and the
Data Grand Lyon column aliases) without touching the network.

To run it against a local Gladys, set `GLADYS_HOST_API_URL`,
`GLADYS_INTEGRATION_TOKEN` and `GLADYS_INTEGRATION_SELECTOR`, then
`npm start`.

## Release

`Actions → Release → Run workflow` bumps the version in `package.json` and in
`gladys-assistant-integration.json`, tags it, and publishes the multi-arch
image to `ghcr.io`. See `.github/workflows/`.

`cover.png` is still the template's placeholder — replace it before publishing
to the store.
