# Homebridge Roborock Vacuum 2 Roadmap

## Worth Doing Now

- Add diagnostics for model resolution, `localKey` presence, and local-vs-cloud readiness in the admin UI.
- Persist enough discovery data to inspect failures after startup.
- Harden model lookup so new Roborock API shapes do not immediately become `unknown`.
- Add targeted tests around discovery parsing, payload normalization, and command transport fallback.
- Keep CI validating both Homebridge `1.11.x` and `2.0.0-beta`.

## Worth Doing Soon

- Add an explicit per-device transport status view that shows `local`, `cloud fallback`, or `unknown`.
- Add clearer logs for `localKey` missing, model lookup mismatches, and unsupported attributes.
- Improve support for recently reported models such as Saros 10, Q5 Max+, QX Revo Plus, and Q10 S5+.
- Reduce brittle model-specific switches by moving feature detection toward schema/capability-based logic.

## Worth Evaluating Carefully

- Optional manual overrides for model mapping when Roborock metadata is incomplete.
- Manual local-IP diagnostics or reconnect tools in the UI.
- A small telemetry/debug export for users opening issue reports.

## Probably Not Worth It

- Rewriting the transport stack from scratch.
- Fork-only divergence without tests or observability.
- Large UI redesign before operational visibility is in place.
