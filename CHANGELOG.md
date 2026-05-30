# Changelog

## 1.4.42

- Fixed Apple Home getting stuck on "Connecting" when commissioning the Matter vacuum by reverting the operational state list to bare state IDs without labels. The manufacturer-range operational states with labels introduced in 1.4.40 were not tolerated by Apple Home during commissioning; this restores the known-good advertisement that paired successfully.

## 1.4.41

- Built the Matter cluster snapshot from the freshest live Roborock status (state, battery, charge) instead of the slower periodic HomeData snapshot, so registration snapshots and Apple Home attribute reads reflect changes sooner.
- Allowed slow saved-map switches (`load_multi_map`) up to 30 seconds before timing out, because older models such as the S6 Pure can take longer than the default 10 seconds to switch maps, and kept transient timeout warnings classified correctly regardless of the configured duration.
- Internal hardening with no behavior change: introduced a typed Roborock API surface for the Matter accessory and consolidated duplicated Matter name normalization to reduce drift.

## 1.4.40

- Restored the original Roborock map after Matter Service Area room refreshes, even when another saved-map load times out, and retried empty saved maps periodically so newly segmented rooms can appear without restarting Homebridge.
- Hardened Matter RVC conformance by using standard Vacuum and Mop clean-mode tags for Vacuum + Mop, moving Roborock-specific operational states into the labeled manufacturer range, and returning INVALID_SET for multi-map room selections.
- Cleared optimistic Matter state after repeated contradicting Roborock updates so Apple Home does not stay on a wrong state until the timeout when a command is acknowledged but has no effect.
- Built only the requested Matter cluster for single-attribute reads and mirrored the Roborock name onto the accessory `name` to reduce generic "Matter Accessory" labels during pairing.

## 1.4.38

- Ensured every Matter Service Area room advertises a matching saved-map entry, using Roborock map names when available and a generated label otherwise, so Apple Home no longer risks getting stuck on Updating when a room references a map without a reported name.
- Cached persisted Roborock state (HomeData, room mappings, transport diagnostics) in memory after the first read to cut repeated disk reads on every status lookup and command while preserving the on-disk file format and legacy migration.
- Removed an unreachable internal command branch and a duplicate status helper, and ignored local tooling files during lint.

## 1.4.37

- Kept unresolved Roborock maps out of Matter Service Area metadata until they have matching room segment IDs, avoiding Apple Home getting stuck on Updating with incomplete map data.
- Avoided reloading the Roborock map that is already active while refreshing Matter room mappings, preventing startup timeouts on models that reject that reload.

## 1.4.36

- Reloaded saved Roborock maps during Matter Service Area refresh even when Roborock reports the map is already active, giving multi-floor rooms another chance to expose segment IDs.
- Published saved Matter Service Area map names as soon as Roborock reports them, even while rooms for a map are still being resolved.
- Documented Matter pairing-name behavior and why Apple Home may ask to add the external vacuum accessory after the bridge is commissioned.

## 1.4.35

- Added capability-gated Matter clean modes for Vacuum, Mop, and Vacuum + Mop on Roborock models that report mop or water support.
- Applied selected Matter clean modes before Matter start/resume commands by updating Roborock suction and water settings where the model exposes those controls.
- Refreshed Matter Service Area room mappings across saved Roborock maps while idle, then restored the original map so multi-floor room lists can populate automatically.
- Applied cached Roborock identity metadata earlier for restored Matter accessories so re-pairing is less likely to show a generic Matter Accessory name.

## 1.4.34

- Prefixed Matter Service Area room labels with the Roborock map name when multiple saved maps are available, so controllers that flatten maps still show floor context.
- Documented the map-name label fallback for Apple Home and other Matter clients that do not expose a separate map picker yet.

## 1.4.33

- Added multi-map Matter Service Area metadata so supported clients can group rooms by saved Roborock maps.
- Cached room mappings per Roborock map and preserved saved map names for upper/lower floor setups.
- Loaded the selected Roborock map before starting Matter room cleaning when a selected area is on another map.

## 1.4.32

- Deferred Matter state pushes until after command handlers return to reduce HomeKit command timeouts.
- Added Matter Service Area map metadata and clearer Matter command/room-selection diagnostics.
- Documented re-pairing the Matter vacuum after changing the Service Area beta setting because controllers can cache the cluster list.

## 1.4.31

- Added an opt-in beta Matter Service Area path that exposes cached Roborock rooms to Matter clients and uses selected rooms for Matter-initiated cleaning.
- Documented the Service Area beta as work in progress and kept it behind a separate setting from the main experimental Matter vacuum.

## 1.4.30

- Moved local/cloud transport transition diagnostics behind debug logging to keep normal Homebridge logs quieter.
- Updated Matter vacuum commands to report the requested state immediately and log Roborock acknowledgment timing.
- Expanded Matter battery power-source state and linked the regular HomeKit battery service to the main accessory.
- Sanitized Roborock scene switch names so generated HomeKit names avoid unsupported characters.

## 1.4.29

- Kept Matter vacuum state optimistic after commands so Apple Home does not fall back to stale ready/idle status while Roborock reports the transition.

## 1.4.28

- Added a Matter RVC clean-mode cluster so Apple Home can complete the native vacuum accessory setup.
- Clarified Matter vacuum setup instructions for child bridge Matter enablement and log-based pairing codes.

## 1.4.27

- Removed the unsupported Matter run-mode startup attribute from experimental vacuum state updates.

## 1.4.26

- Fixed experimental Matter vacuum registration by omitting standard operational-state labels that Matter rejects during conformance validation.

## 1.4.25

- Added optional experimental Matter robotic vacuum exposure for Homebridge 2 with Matter enabled.
- Kept the existing HomeKit fan/switch accessory path active for backwards compatibility.
- Documented the Matter setting and Phase 1 command mapping in the README, roadmap, and admin UI.

## 1.4.24

- Changed transient timeout warning throttling to group repeated polling failures per vacuum instead of per command.
- Increased the default transient warning interval to 6 hours and added a configurable Homebridge/UI setting.
- Added support for setting the transient warning interval to 0 so recurring transient warnings only appear when debug logging is enabled.

## 1.4.23

- Throttled repeated transient command warnings so recurring Roborock polling timeouts are logged periodically instead of every refresh cycle.

## 1.4.22

- Added dedicated HomeKit momentary switches for Pause Cleaning and Return to Dock.
- Changed the main HomeKit off action to stop cleaning only instead of also sending a dock command.
- Clarified cloud-only transport logs so expected Roborock cloud calls are not described as fallback from local control.

## 1.4.21

- Added plain-English transport transition logs for local TCP connections, cloud fallback, local recovery, remote/shared devices, offline state, missing local credentials, and missing local IP discovery.
- Reduced duplicate fallback logging and stopped printing local keys in debug discovery logs.

## 1.4.20

- Added a "Test Local Connection" action in the admin UI that performs a live LAN TCP probe for each cached vacuum.
- Included local test results in copied diagnostic reports with DUIDs and local IPs still redacted.

## 1.4.19

- Added a short diagnostics auto-refresh after admin UI startup when the first snapshot is not locally connected.
- Added transport freshness timestamps to diagnostic cards and copied diagnostic reports.

## 1.4.18

- Updated the roadmap to reflect completed diagnostics, Homebridge compatibility, CI, release automation, and security work.
- Improved diagnostics wording so local credentials, local TCP connectivity, cloud fallback, and offline states are easier to understand.
- Added a redacted "Copy Diagnostic Report" action for future GitHub Issues.
- Added GitHub Issue templates for bug reports, feature requests, and model support reports.

## 1.4.17

- Maintenance release to verify the trusted publishing and GitHub release automation after the admin UI and diagnostics updates.
- No runtime behavior changes from `1.4.16`.

## 1.4.16

- Improved the Homebridge admin UI for readability with clearer section layout, status messaging, help text, and explicit settings save behavior.
- Documented all plugin settings in the Homebridge schema and README, including region selection, encrypted tokens, password fallback, debug logging, and skipped devices.
- Added serial numbers to UI diagnostics so ignored device values are easier to copy from the admin panel.
- Fixed `skipDevices` so Homebridge config values are passed into discovery and can match either Roborock serial numbers or DUIDs.

## 1.4.15

- Tightened obstacle photo handling in the map UI to accept only base64-encoded image data and render it through browser-generated blob URLs.
- Added blob URL cleanup when closing or replacing obstacle photos to avoid leaking browser-side object URLs.

## 1.4.14

- Hardened region detection by parsing the configured Roborock host instead of using substring matches.
- Sanitized map obstacle image URLs before assigning them in the browser UI to reduce XSS and client-side redirect risk.
- Added explicit read-only permissions to the CI workflow, upgraded GitHub Actions versions, and moved Codecov uploads to a repository secret.

## 1.4.13

- Adjusted `package.json` repository metadata to match the fork URL exactly for npm Trusted Publishing compatibility.
- Updated the npm publish workflow to use Node 24 and the latest npm CLI for Trusted Publishing compatibility.

## 1.4.12

- Improved model resolution and startup hardening for newer Roborock metadata layouts.
- Added diagnostics in the Homebridge UI for model detection, local key availability, discovery state, local IP, TCP connection state, and last transport used.
- Fixed updater payload crashes caused by malformed or partial cloud/local message payloads.
- Improved room mapping behavior with clearer logging and fallback labels when Roborock room names are missing.
- Replaced forced hourly MQTT reconnects with a health-check-based reconnect path.
- Added guards against transient `0%` battery reports while the robot is docked or charging to reduce false HomeKit low-battery alerts.
- Added regression tests around transport selection, room mapping, and model/diagnostics handling.
- Added incremental TypeScript-style checking for the core transport queue and a `typecheck` script for ongoing migration work.
- Added GitHub Actions automation for npm publishing on `master` using npm Trusted Publishing.

## 1.2.2

- **New Feature**: Dynamic Scene Switch Management
  - Automatically create HomeKit switch buttons for each device's available scenes
  - Scene switches named after scene names with momentary switch behavior
  - Automatically add/remove corresponding switch buttons when scenes change
  - Execute corresponding scenes when switches are pressed, with error handling and status feedback
  - Synchronize scene switches when HomeData is updated
- **Improvement**: Refactored scene API methods, separated scene fetching and device filtering functionality
- **Fix**: Resolved recursive call issue in scene methods

## 1.0.15

- Fix Roborock Saros 10R Status issue

## 1.0.6

- Support new model

## 1.0.0

- First version.
