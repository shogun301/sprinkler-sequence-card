# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-08-31

### Changed

- Rewrote the repository, card-picker, runtime, and preview descriptions in
  direct Home Assistant terminology.

## [0.1.1] - 2026-08-31

### Added

- Original Sprinkler Sequence logo with SVG source and 256/512-pixel PNG exports.

## [0.1.0] - 2026-08-30

### Added

- Provider-neutral sequence and single-zone adapters.
- Constrained WyzeAPI preset with backend-owned sequencing and timers.
- Configurable target, zones, service names, field mappings, runtime mappings, and safety limits.
- Optional state-aware pause, resume, and stop controls.
- Fail-closed handling for absent, unknown, unmapped, or pending controller states.
- Visual editor for common configuration and YAML support for advanced mappings.
- Synthetic lifecycle, duration, runtime, and exact-service-call tests.
- HACS metadata, validation workflow, privacy scan, documentation, and preview asset.

[Unreleased]: https://github.com/shogun301/sprinkler-sequence-card/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/shogun301/sprinkler-sequence-card/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shogun301/sprinkler-sequence-card/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shogun301/sprinkler-sequence-card/releases/tag/v0.1.0
