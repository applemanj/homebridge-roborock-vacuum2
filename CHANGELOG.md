# Changelog

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
