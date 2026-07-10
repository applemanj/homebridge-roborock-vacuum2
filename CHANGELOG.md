# Changelog

## 1.4.65

- Internal cleanup pass across the whole codebase: removed duplicated logic (shared crypto helpers, shared live-message parsing, consolidated device-model tables), deleted dead code, and simplified several hot paths (parallelized independent requests, reduced redundant JSON parsing/buffer reads) with no intended behavior changes. Verified against a live Roborock S6 Pure over Matter (start, pause, dock).
- Fixed a display bug in the Homebridge UI's Matter pairing card where a real pairing/setup code could be mistaken for "not available" if it happened to match the literal placeholder text used for missing codes.
- Fixed plugin config local test failing after first successful run within the same config session. The TCP socket probe was not properly managing socket lifecycle, which could cause resource exhaustion on subsequent test runs. Added `socket.unref()` to prevent sockets from keeping the Node process alive and improved error handling during socket cleanup. Addresses issue #13.

## 1.4.63

- Matter Pause and Return to Dock are now always forwarded to the robot instead of being dropped when the plugin's cached state looks idle. The cache can lag or be overridden by a stale HomeData refresh while the robot is really cleaning, which previously made the plugin silently reject real pause/dock commands as "not cleaning" / "already docked" (seen on a Roborock S7 `roborock.vacuum.a15` that was room-cleaning while HomeData reported it as charging). A redundant pause/dock on an already-docked robot is a harmless no-op. Addresses issue #12.
- Fixed the Matter Cleaning tile collapsing back to Docked/Ready in Apple Home almost immediately after Start on models that sync slowly through the cloud (e.g. S8 / `roborock.vacuum.a51`). The optimistic Cleaning state is now held through the lagging "still docked/charging" reports during the recent-command window after a Start/Resume/area-clean, instead of being abandoned after two contradicting reports, so the tile stays on Cleaning — and Return to Dock stays available — until the robot actually reports Cleaning. It still falls back to the real state once that window passes, so a start the robot never acted on (e.g. a full bin) does not stay stuck on Cleaning. Follow-up to the 1.4.60 command-forwarding fix for issue #4.

## 1.4.62

- Added explicit package author metadata so npm identifies Joshua Appleman as the package author while keeping trusted GitHub Actions publishing intact.

## 1.4.61

- Kept Matter RVC state publishes as serialized full snapshots for all refresh paths, including live updates and Service Area selection changes, so Apple Home is not left depending on partial cluster writes after controller refreshes.
- Removed the plugin's explicit RVC Operational State `operationalError` write and added tests pinning the Matter RVC mode clusters without unsupported `startUpMode`/`onMode` attributes.
- Added rechargeable battery metadata to the optional Matter Power Source cluster, including nullable charging-current and time-to-full-charge values.
- Improved the Homebridge UI Matter Pairing lookup to search common Docker/Homebridge Matter storage paths and keep loading pairing data even when plugin config is unavailable.
- Updated Matter RVC `Updating...` documentation after the live Homebridge 2.1.1-beta reset/re-pair test rendered the full RVC endpoint correctly in Apple Home.

## 1.4.60

- Fixed Matter Pause and Return to Dock being silently dropped on models that sync slowly (e.g. Roborock S8 / `roborock.vacuum.a51`, which fall back to the cloud). After a Matter Start, these robots can keep reporting "docked/charging" for tens of seconds before they report "Cleaning"; during that lag the plugin's cached state was stale, so a follow-up pause/dock was rejected as "not cleaning" / "already docked." An explicit Matter pause/dock issued within 60s of a start/resume/area-clean is now forwarded to the robot even when the cached snapshot still reads docked (a redundant pause/dock on an already-docked robot is a harmless no-op). The Pause control also gained the same in-flight-command allowance that Return to Dock already had. Addresses issue #4.

## 1.4.59

- Made the HomeKit Pause Cleaning and Return to Dock switches wait for Roborock acknowledgement and log command timing, matching the fan Start/Stop path. Previously these were fire-and-forget, so a pause/dock that the robot did not acknowledge (e.g. once it is already cleaning) failed silently with no log; they now surface the acknowledgement time or a clear timeout/error to aid diagnosis.

## 1.4.58

- Fixed the root cause of Apple Home getting stuck on "Updating..." until Play Sound to Locate was pressed: Matter publishes are now serialized full snapshots with no plugin-side change tracking, so racing state updates can no longer leave the Matter store holding a stale value that the plugin refused to re-send. Verified at the Matter protocol level against a live Homebridge 2.1.1-beta container.
- Restored spec-conformant RVC Operational State phase attributes (`phaseList`/`currentPhase` are null again) and removed the synthetic identify pulses and phase flapping that were broadcast to every Apple Home hub as refresh signals. The nulls are written on every publish so upgraded installs repair their Matter store without re-pairing.
- Replaced the 5-second active-state heartbeat with a quiet 60-second full-snapshot safety net; matter.js suppresses unchanged writes, so steady-state Matter traffic drops to normal keep-alives.
- Kept Play Sound to Locate (Identify) working as a manual full-state resync, and added regression tests pinning publish serialization, null phase attributes, full-snapshot republishes, and the no-synthetic-identify rule.

## 1.4.57

- Hardened Roborock MQTT protocol 300/301 parsing so short cloud payloads are skipped cleanly instead of throwing `RangeError` during inbound message handling.
- Made legacy HomeKit fan Start/Stop commands wait for Roborock acknowledgement and log command timing, improving diagnostics for models where switches appear to do nothing.
- Propagated Matter command errors/timeouts reliably and added one bounded Matter Return to Dock retry when Roborock still reports active cleaning after an ambiguous `app_charge` timeout.

## 1.4.56

- Hardened Roborock live cloud/local status routing so device-scoped updates are delivered only to the matching vacuum, and unscoped live arrays are ignored when multiple vacuums are configured.
- Added normal Homebridge log entries when the legacy HomeKit fan accessory receives Start/Stop writes, making it easier to tell whether a failed command reached the plugin.
- Added regression coverage for multi-vacuum live-message routing and unscoped live payload handling.

## 1.4.55

- Kept Matter optimistic state after Roborock cloud or local command acknowledgement timeouts and started an immediate fast follow-up refresh cadence so Apple Home can converge once live `get_status` catches up.
- Allowed Matter Return to Dock to send `app_charge` after a recently timed-out Start even when the cached Roborock snapshot still says docked or charging.
- Added regression coverage for timed-out Matter commands, fast status refreshes, and stale docked snapshots during follow-up dock requests.

## 1.4.54

- Bounded Matter clean-mode preparation so slow Roborock cloud acknowledgements for fan or mop settings no longer delay the actual Start command for 30-40 seconds.
- Limited Matter clean-mode prep commands to a short request timeout and kept Start moving with optimistic state when prep is slow or ambiguous.
- Stopped trying alternate Roborock water-mode commands after timeout errors, while still falling back for unsupported or unknown command responses.

## 1.4.53

- Improved Matter state reads so Apple Home can receive cached/live vacuum state quickly while the plugin refreshes Roborock in the background, reducing long `Updating...` stalls after reopening Home.
- Added a Matter Pairing section to the Config UI that reads Homebridge commissioning data and shows the Roborock child/daughter bridge QR code plus each vacuum's 11-digit setup code after restart.
- Improved the Config UI local connection test to recognize an already-active or recently-used local Roborock connection and show the source of the diagnostic result.
- Moved debug logging and Roborock cloud fallback toggles into an Advanced troubleshooting section so the normal setup flow stays focused on account, Matter, and pairing.
- Quieted repeated `get_status` warnings for known Roborock status fields when Homebridge has not created a matching diagnostic state object, while keeping warnings for genuinely new fields.

## 1.4.52

- Delayed and retried Matter state refreshes while Homebridge reports a freshly registered endpoint is still initializing, reducing startup AccessControl warnings after bridge or child-bridge restarts.
- Added compact Roborock status diagnostics to copied Config UI reports, including recent `get_status` and live cloud/local payloads for troubleshooting incorrect current-state or room-status reports.
- Captured compact `get_server_timer` and `get_timer` responses while debug logging is enabled so schedule-switch feature requests can be investigated without exposing credentials.

## 1.4.51

- Scoped live Roborock cloud/local status updates to the source vacuum so one robot's push messages no longer update every configured HomeKit or Matter vacuum.
- Kept Matter optimistic state after Roborock command acknowledgement timeouts, avoiding stale Idle/Charging rollbacks when the robot accepted the command but the cloud acknowledgement arrived late or not at all.
- Made the Config UI local connection test recover from stalled requests and skip LAN probing when **Use Roborock cloud only** is enabled.

## 1.4.50

- Fixed the Node current CI test failure by isolating Matter timer cleanup in tests and adding a safe timer fallback for deferred Matter state updates when the test runtime removes the global timer.

## 1.4.49

- Added **Use Roborock cloud only** to disable local LAN discovery and local TCP commands for installations where local sockets appear connected but repeatedly time out; commands and status polling now route through Roborock cloud when available.
- Updated diagnostics and copied reports to show cloud-only mode clearly instead of stale local connection state.
- Graduated Matter Service Area room selection from a separate beta checkbox so it is included automatically whenever the Matter vacuum is enabled.

## 1.4.48

- Applied **Prefer Roborock cloud for Matter commands** to Matter follow-up status refreshes as well as commands, so S8-style local status timeouts do not leave Apple Home stuck on Cleaning after the robot returns to dock.
- Passed the Matter cloud preference through the Roborock status polling stack down to the underlying `get_prop/get_status` request.

## 1.4.47

- Kept the Matter vacuum run mode active while Roborock is returning to dock, avoiding an inconsistent Idle/Returning state combination that could make Apple Home show "No Response" during the charging transition.

## 1.4.46

- Preferred Roborock cloud acknowledgements for Matter saved-map switches before selected-area cleaning, avoiding local `load_multi_map` acknowledgement timeouts that could leave Apple Home stuck on "Updating...".
- Continued Matter selected-area cleaning when Roborock has already switched to the requested saved map even if the map-load acknowledgement reports a timeout.

## 1.4.45

- Added an optional **Prefer Roborock cloud for Matter commands** setting so Matter vacuum commands can bypass local LAN command timeouts on models such as the S8 while leaving the existing HomeKit accessories on their normal transport path.
- Forced short follow-up status refreshes after Matter commands are acknowledged so Apple Home can move out of optimistic states such as Returning once Roborock reports the real charging/docked status.
- Ignored empty Roborock cloud push results so `CloudMessage data: undefined` packets no longer get forwarded as accessory updates.

## 1.4.44

- Treated unsupported Roborock clean-mode setting responses such as `unknown_method` as best-effort during Matter starts, so models that reject water-box commands can still continue to the actual start command and remember the unsupported setting path.

## 1.4.43

- Cleared stale remote-fallback markers when a vacuum reconnects over local TCP, so polling can return to local transport instead of staying pinned to Roborock cloud after a temporary connect failure.

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
