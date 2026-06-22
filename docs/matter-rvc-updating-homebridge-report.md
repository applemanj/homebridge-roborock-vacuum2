# Matter Robotic Vacuum Cleaner (device type 0x74) never leaves "Updating…" in Apple Home

> Draft bug report for **github.com/homebridge/homebridge**. Evidence gathered live from a running Homebridge 2.1.1‑beta.1 container.

## Summary

A Matter Robotic Vacuum Cleaner (RVC, device type `0x74`) exposed through Homebridge 2's Matter API commissions successfully into Apple Home, the controller subscribes and reads every attribute **without error**, but the accessory tile is **permanently stuck on "Updating…"** and never becomes controllable.

The exposing plugin has been exonerated (see "Ruled out"), so this appears to be in the Homebridge/matter.js RVC presentation layer or an Apple‑side RVC limitation. Filing here because Homebridge owns the Matter device composition and is the layer we can act on; happy to redirect to Apple if maintainers can confirm the device model is correct.

## Environment

| | |
|---|---|
| Homebridge | **2.1.1‑beta.1** (also the newest published; `latest` = 2.1.0) |
| matter.js (`@matter/main`) | **0.17.2-alpha.0-20260605-b2c9f3f65** |
| Node | 24.17.0 (Docker `homebridge/homebridge:beta`) |
| Exposing plugin | homebridge-roborock-vacuum2 1.4.58 (also reproduced on 1.4.42) |
| Controller | Apple Home, multi‑hub (Apple TV + HomePod), current iOS/tvOS |
| Device | Roborock S6 Pure exposed as RVC `0x74` rev 4 |

The RVC is published as a **standalone external Matter node** (its own commissioning node, separate from the child bridge's aggregator node), which is the documented Homebridge behavior for robotic vacuums.

Endpoint as instantiated by Homebridge:

```
endpoint#1 type: RoboticVacuumCleaner (0x74, rev 4)
behaviors: ✓identify ✓rvcRunMode ✓rvcOperationalState ✓rvcCleanMode ✓serviceArea ✓powerSource ✓descriptor
```

## Symptom

- Commissioning completes: `generalCommissioning.commissioningComplete errorCode: 0`.
- The controller establishes a subscription and reads the RVC endpoint.
- The Apple Home tile shows **"Updating…" indefinitely** and is never controllable.
- It briefly clears if an `Identify` command is invoked (e.g. "Play Sound to Locate"), then reverts — i.e. a command round‑trip forces a one‑time re‑render, but passive subscription data does not.

## Reproduction

1. Expose any Matter RVC (`0x74`) via Homebridge 2.1.x‑beta Matter.
2. Commission it into Apple Home.
3. Observe the tile never leaves "Updating…".

## What we ruled out (each with evidence)

| Hypothesis | Test | Result |
|---|---|---|
| Exposing plugin / its data | Deployed a known‑good older plugin build | **Identical failure** |
| Stale/corrupt controller record | Full remove + fresh re‑pair (multiple times) | Still "Updating…" |
| Transport / reachability | Inspected the subscription | Controller subscribes, reads endpoint 1, **0 attribute errors**, ACKs all reports, then settles (no read loop) |
| Service Area cluster | Removed `serviceArea` from the endpoint, re‑paired | Still "Updating…" |
| Multi‑admin contamination | Device is co‑commissioned to Apple (vendor 4937) + Amazon (vendor 4996) | Amazon fabric is **idle (0 messages)**; multi‑admin is normal — not the cause |

## Wire‑level evidence

The persisted RVC Operational State cluster is spec‑conformant (PhaseList/CurrentPhase null, only base states advertised, no labels):

```json
{
  "phaseList": null,
  "currentPhase": null,
  "operationalStateList": [
    {"operationalStateId": 0}, {"operationalStateId": 1},
    {"operationalStateId": 2}, {"operationalStateId": 3}
  ],
  "operationalState": 0,
  "operationalError": {"errorStateId": 0}
}
```

`rvcRunMode` / `rvcCleanMode` advertise valid `supportedModes` with conformant `modeTags`, and each `currentMode` exists in its `supportedModes`. The controller reads all of this with no `Status=Unsupported*`/constraint errors (only the benign `OTA Requestor (0x2A)` and Apple vendor‑cluster `0x1349…` probes return UnsupportedCluster, as expected).

So: the controller receives correct, conformant, error‑free RVC data over a healthy subscription, and refuses to render the tile.

## What we suspect / open question

Since the controller never errors on a read yet won't render, the gap is likely one of:

1. **The RVC endpoint composition** Homebridge/matter.js produces for `0x74` is missing or mis‑shaping something Apple's RVC client requires to initialize the tile (a mandatory attribute/feature, cluster revision, or the standalone‑node vs bridged structure), **or**
2. **Apple's RVC client** doesn't fully support an RVC presented this way on the current iOS/tvOS.

**Questions for maintainers:**
- Is Matter RVC (`0x74`) via Homebridge 2.1.x expected to render in Apple Home today, or is it a known gap/limitation?
- Is the **standalone external node** the correct structure for RVC, and does Apple's RVC client require anything beyond what `@matter/main` 0.17.2 emits for this device type?
- Are there required RVC attributes/feature‑map bits (e.g. on RVC Operational State, or Service Area conformance) that the device type should be advertising but isn't?

## How to isolate Homebridge vs Apple definitively

Pair the same RVC node into a **non‑Apple ecosystem with real RVC support (Google Home)**:
- Renders in Google but not Apple ⇒ **Apple RVC client** issue.
- Fails in Google too ⇒ **Homebridge/matter.js RVC output** issue.

(We could not use Alexa for this — Amazon co‑commissions the node automatically but its RVC support doesn't surface a usable tile, so it's not a clean comparison.)

## Notes

- The Apple + Amazon dual‑fabric is normal Matter multi‑admin (the Amazon fabric is created by the iOS‑level linked‑ecosystem handoff, not the plugin) and is **not** the cause — the failure reproduces identically and the Amazon fabric is idle.
- Logs (commissioning, subscription, attribute reads, persisted cluster state) are available on request, redacted of pairing codes.
