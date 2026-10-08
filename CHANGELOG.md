# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [2.2.1] - 2026-10-08

### Fixed

- Departure countdowns were one or two hours too long: the passage times the
  departures layer publishes carry no time zone and were read in the
  container's (UTC). They are now read as Lyon time, daylight-saving changes
  included; a time that carries its own offset is read as it says.
- A device added (or updated from the Discovery screen) is read at once and its
  values published whole, instead of waiting up to fifteen minutes for the ones
  that did not change.
- A read that fails is tried again a minute later instead of after the whole
  refresh interval (five minutes for a park & ride).
- A slow read that failed late no longer threw away the newer cached read that
  had replaced it (park & ride, stop directory, Vélo'v feeds).
- The responses that are never read (redirects, refused account, retired layer
  names) are released at once instead of holding a connection.

### Changed

- The departures reads are capped at 200 records, and a warning is logged when
  the platform answers about other stops than the one asked for.
- The dashboard widgets reuse the last reading of the device while it is fresh,
  and widgets pulled at the same moment share one read.
- Node.js 22 or later is required (the image ships Node 24).
- An unexpected promise rejection is logged instead of stopping the container.

## [2.2.0] - 2026-10-07

### Fixed

- A batch of states Gladys refused is sent again on the next poll, instead of
  being taken for delivered for fifteen minutes.
- The "departure in N minutes" trigger follows the same vehicle between two
  reads, so it no longer misses a departure when the one ahead of it has left.
- A widget answers before the core gives up on it: past 9 s it shows a loading
  card and the read completes in the background.

### Changed

- Continuous integration runs the store admission checks on pull requests, and
  Dependabot keeps the dependencies and actions up to date.

## [2.1.1] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

## [2.0.0] - 2026-09-22

### Added

- Add the Gladys 5.1 dashboard widgets, scene triggers and scene actions

## [1.0.4] - 2026-09-04

### Changed

- Say why a park & ride publishes no free spaces
- Use the neutral capacity of the examples

## [1.0.3] - 2026-08-31

### Changed

- Publish only where Gladys can store, and say so when it cannot

## [1.0.2] - 2026-08-31

### Changed

- Publish something on a park & ride nobody counts live

## [1.0.1] - 2026-08-31

First public release.

### Added

- Transports en Commun Lyonnais integration

### Changed

- Explain how to set the password without an old one
- Follow dataset renames and stop timing out on stop search
- Read the park & ride dataset under the name SYTRAL publishes today
- Use a network landmark in the publication log example
- Publish a min/max on the text features so Gladys accepts the devices
- Publish the flag Gladys reads to schedule a device
- Show where each line goes in the stop search, and store less

### Fixed

- Fix the store manifest validation errors, add CLAUDE.md and a new cover
- Translate every placeholder into an { en, fr } object
- Make the account actually work with GrandLyon Connect
- Survive a republished dataset instead of reporting HTTP 404
- Publish devices Gladys accepts, list every P+R, file the integration under a real category

[Unreleased]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.0.0...v2.1.1
[2.0.0]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.4...v2.0.0
[1.0.4]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-transport-commun-lyonnais/releases/tag/v1.0.1
