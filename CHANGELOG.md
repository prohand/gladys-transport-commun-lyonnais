# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

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

[Unreleased]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v2.0.0...v2.1.1
[2.0.0]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.4...v2.0.0
[1.0.4]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-transport-commun-lyonnais/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-transport-commun-lyonnais/releases/tag/v1.0.1
