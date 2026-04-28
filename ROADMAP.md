# Homebridge Roborock Vacuum 2 Roadmap

## Recently Completed

- Added admin UI diagnostics for model resolution, local credential availability, local IP discovery, TCP connection state, and last cloud/local transport.
- Persisted discovery and transport state so failures can be inspected after startup.
- Hardened model lookup against newer Roborock HomeData shapes.
- Added regression coverage for discovery parsing, room mapping, payload normalization, battery handling, and transport fallback behavior.
- Added CI validation for Homebridge `1.11.x` and `2.0.0-beta`.
- Improved npm trusted publishing, GitHub release automation, and CodeQL security hygiene.
- Improved the Homebridge admin UI layout, setting descriptions, and diagnostics readability.
- Added GitHub Issue templates for bug reports, feature requests, and model support reports.

## In Progress

- Make per-device diagnostics explain connection state in plain language instead of exposing implementation terms such as `localKey`.
- Add a redacted diagnostics report users can copy into GitHub Issues without leaking tokens or local keys.

## Worth Doing Next

- Add a manual "Test local connection" action in the admin UI that performs a lightweight local probe and reports the result.
- Add clearer transport logs for missing local credentials, failed TCP connects, model lookup mismatches, and unsupported attributes.
- Improve scene and room controls so HomeKit exposes room cleaning shortcuts with cleaner names and fewer invalid characteristic warnings.
- Add HomeKit controls for return-to-dock, pause/resume, and supported fan or cleaning modes where the HomeKit service model allows it.
- Improve support for recently reported models such as Saros 10, Q5 Max+, QX Revo Plus, and Q10 S5+.
- Reduce brittle model-specific switches by moving feature detection toward schema/capability-based logic.
- Review GitHub Issues regularly for new model reports, diagnostics exports, and feature requests.

## Worth Evaluating Carefully

- Optional manual overrides for model mapping when Roborock metadata is incomplete.
- Optional manual local IP override or reconnect tools in the UI.
- Native HomeKit vacuum support if Homebridge/HAP exposes a stable service in the future.

## Probably Not Worth It

- Rewriting the transport stack from scratch.
- Fork-only divergence without tests or observability.
- Large UI redesign before operational visibility is in place.
