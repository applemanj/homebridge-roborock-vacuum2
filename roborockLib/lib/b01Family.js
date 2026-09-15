// @ts-check
"use strict";

/**
 * B01 family detection.
 *
 * `pv === "B01"` is TWO wire protocols, not one:
 *
 *  - **Q7** (`roborock.vacuum.sc*`) carries an RPC envelope on datapoint 10000:
 *    `{"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}`
 *  - **Q10** (`roborock.vacuum.ss*`) writes a numbered datapoint directly, with
 *    no method, no msgId and no datapoint 10000 at all: `{"dps":{"201":1}}`
 *
 * Datapoint 10000 is not in the Q10 datapoint set, so a Q7-framed request sent
 * to a Q10 is correctly framed, correctly encrypted, addressed to a datapoint
 * the robot does not have, and silently discarded. A Q10 also sends no RPC
 * reply at all, so such a request then waits out its full timeout on a
 * perfectly healthy link — which is the false "the cloud went silent"
 * diagnosis behind issue #10.
 */

const B01_PROTOCOL_VERSION = "B01";

const B01_FAMILY = { Q7: "Q7", Q10: "Q10" };

/**
 * True when a robot's `pv` marks it as speaking a B01 dialect.
 * @param {string | null | undefined} version
 * @returns {boolean}
 */
function isB01Protocol(version) {
  return version === B01_PROTOCOL_VERSION;
}

/**
 * Which B01 family a model belongs to.
 *
 * Anchored on the model suffix, so only a model whose own name part starts with
 * `ss` is treated as Q10. An unanchored substring test would misroute any
 * future model that merely contains those letters.
 *
 * Q7 is the default for `sc*` and for anything unrecognised: it is what every
 * B01 device was treated as before this function existed, so an unknown model
 * cannot be made worse here than it already was.
 *
 * @param {string | null | undefined} model
 * @returns {string}
 */
function b01FamilyForModel(model) {
  const suffix = String(model ?? "")
    .split(".")
    .pop()
    ?.toLowerCase();

  if (suffix && suffix.startsWith("ss")) {
    return B01_FAMILY.Q10;
  }

  return B01_FAMILY.Q7;
}

module.exports = {
  B01_PROTOCOL_VERSION,
  B01_FAMILY,
  isB01Protocol,
  b01FamilyForModel,
};
