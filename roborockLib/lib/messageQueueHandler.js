// @ts-check
"use strict";

const DEFAULT_REQUEST_TIMEOUT = 10000; // 10s

const b01Q10Adapter = require("./b01Q10Adapter");
const { isB01Protocol, b01FamilyForModel, B01_FAMILY } = require("./b01Family");

// Some commands legitimately take longer to acknowledge. Switching the active
// saved map (load_multi_map) can take well over the default timeout on older
// models such as the S6 Pure, so give it more headroom before timing out.
/** @type {Record<string, number>} */
const METHOD_REQUEST_TIMEOUTS = {
  load_multi_map: 30000, // 30s
};

/**
 * @param {string} method
 * @param {number} [requestTimeoutMs]
 * @returns {number}
 */
function getRequestTimeout(method, requestTimeoutMs) {
  const override = Number(requestTimeoutMs);
  if (Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }

  return METHOD_REQUEST_TIMEOUTS[method] || DEFAULT_REQUEST_TIMEOUT;
}

/**
 * @typedef {Object} PendingRequest
 * @property {(value: unknown) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {ReturnType<typeof setTimeout>} timeout
 */

/**
 * @typedef {Object} TransportDiagnosticsUpdate
 * @property {"cloud" | "local" | "local-pending"} [lastTransport]
 * @property {string} [lastTransportReason]
 * @property {string} [lastCommandMethod]
 */

/**
 * @typedef {Object} MessageBuilder
 * @property {(duid: string, protocol: number, messageID: number, method: string, params: unknown[], secure: boolean, photo: boolean, options?: {b01Q10Dps?: Record<string, any>}) => Promise<unknown>} buildPayload
 * @property {(duid: string, protocol: number, timestamp: number, payload: unknown) => Promise<Buffer | null | undefined>} buildRoborockMessage
 */

/**
 * @typedef {Object} LocalConnector
 * @property {(duid: string) => boolean} isConnected
 * @property {(duid: string, message: Buffer) => void} sendMessage
 * @property {(duid: string) => void} clearChunkBuffer
 * @property {(duid: string) => Promise<void>} [ensureL01Handshake]
 */

/**
 * @typedef {Object} MqttConnector
 * @property {() => boolean} isConnected
 * @property {(duid: string, message: Buffer) => void} sendMessage
 */

/**
 * @typedef {Object} LoggerLike
 * @property {(message: string) => void} debug
 * @property {(message: string) => void} info
 */

/**
 * @typedef {Object} RoborockConfig
 * @property {boolean} [cloudOnlyMode]
 */

/**
 * @typedef {Object} MessageQueueAdapter
 * @property {RoborockConfig} [config]
 * @property {(duid: string) => Promise<boolean>} isRemoteDevice
 * @property {(duid: string) => Promise<string>} getRobotVersion
 * @property {(duid: string, attribute: string) => string | null} [getProductAttribute]
 * @property {(duid: string) => Promise<boolean>} onlineChecker
 * @property {MqttConnector} rr_mqtt_connector
 * @property {LocalConnector} localConnector
 * @property {MessageBuilder} message
 * @property {() => number} getRequestId
 * @property {Map<number, PendingRequest>} pendingRequests
 * @property {(callback: () => void, timeout: number) => ReturnType<typeof setTimeout>} setTimeout
 * @property {(timeout: ReturnType<typeof setTimeout>) => void} clearTimeout
 * @property {LoggerLike} log
 * @property {(duid: string, update: TransportDiagnosticsUpdate) => Promise<void>} updateTransportDiagnostics
 * @property {(duid: string) => Promise<boolean>} [ensureLocalConnection]
 * @property {(message: string, location: string, duid?: string) => void} catchError
 */

/**
 * @typedef {Object} RequestOptions
 * @property {boolean} [preferCloud]
 * @property {boolean} [preferLocal]
 * @property {boolean} [allowOfflineCloudSend]
 * @property {number} [requestTimeoutMs]
 */

class messageQueueHandler {
  /**
   * @param {MessageQueueAdapter} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @param {unknown[]} params
   * @param {boolean} [secure=false]
   * @param {boolean} [photo=false]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown | undefined>}
   */
  async sendRequest(
    duid,
    method,
    params,
    secure = false,
    photo = false,
    options = {}
  ) {
    const remoteConnection = await this.adapter.isRemoteDevice(duid);
    const version = await this.adapter.getRobotVersion(duid);

    // B01 covers two different wire dialects. `ss*` models (Q10) write numbered
    // datapoints directly and never reply, so the Q7 envelope below would be
    // discarded by the robot and the request would sit until its timeout
    // expired. Translate here, at the single choke point every B01 write passes
    // through, and hand the encoder a pre-built datapoint map. This runs before
    // any connection work because a refused method must not reach the wire, and
    // must not trigger a local reconnect on its way to being refused.
    /** @type {Record<string, any> | null} */
    let b01Q10Dps = null;
    if (isB01Protocol(version)) {
      const model = this.adapter.getProductAttribute?.(duid, "model");
      if (b01FamilyForModel(model) === B01_FAMILY.Q10) {
        const q10 = b01Q10Adapter.translateOutgoing(method, params);
        if (!q10) {
          // Reads, and any command with no datapoint equivalent, are refused
          // immediately. Refusing beats translating: a read's answer *is* the
          // value, and the Q10 dialect never answers, so a translated read
          // would have to invent one. `catchError` treats this code as an
          // expected capability gap rather than a failure.
          const error = Object.assign(
            new Error(
              `Robot ${duid} (${model || "ss*"}) speaks the B01 Q10 dialect, which writes numbered datapoints and sends no reply. It has no equivalent for ${method}, which would need a reply to be meaningful, so nothing was sent.`
            ),
            { code: "B01_METHOD_UNSUPPORTED" }
          );
          throw error;
        }
        b01Q10Dps = b01Q10Adapter.buildDps(q10.dp, q10.params);
      }
    }

    const deviceOnline = await this.adapter.onlineChecker(duid);
    const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    let localConnectionState = this.adapter.localConnector.isConnected(duid);
    const cloudOnlyConnection = Boolean(this.adapter.config?.cloudOnlyMode);
    const preferCloudConnection =
      Boolean(options.preferCloud) && mqttConnectionState;
    const preferLocalConnection =
      Boolean(options.preferLocal) &&
      !cloudOnlyConnection &&
      !preferCloudConnection &&
      !remoteConnection &&
      !secure &&
      !photo &&
      method != "get_network_info";

    if (
      preferLocalConnection &&
      !localConnectionState &&
      typeof this.adapter.ensureLocalConnection == "function"
    ) {
      await this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "local-pending",
        lastTransportReason: "preferred-local-reconnect",
        lastCommandMethod: method,
      });
      await this.adapter.ensureLocalConnection(duid);
      localConnectionState = this.adapter.localConnector.isConnected(duid);
    }

    let useCloudConnection =
      cloudOnlyConnection ||
      preferCloudConnection ||
      remoteConnection ||
      secure ||
      photo ||
      method == "get_network_info";
    if (!useCloudConnection && !localConnectionState && mqttConnectionState) {
      useCloudConnection = true;
      await this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "cloud",
        lastTransportReason: "local-unavailable-fallback",
        lastCommandMethod: method,
      });
      this.adapter.log.debug(
        `Local connection unavailable for ${duid}. Falling back to cloud connection for method ${method}.`
      );
    }

    if (!useCloudConnection && version == "L01") {
      try {
        if (this.adapter.localConnector.ensureL01Handshake) {
          await this.adapter.localConnector.ensureL01Handshake(duid);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.adapter.log.debug(
          `L01 handshake before request failed for ${duid}: ${errorMessage}`
        );
      }
    }

    let messageID = this.adapter.getRequestId();
    if (photo) messageID = messageID % 256; // this is a special case. Otherwise photo requests will not have the correct ID in the response.
    const timestamp = Math.floor(Date.now() / 1000);

    const protocol = useCloudConnection ? 101 : 4;
    const allowOfflineCloudSend =
      Boolean(options.allowOfflineCloudSend) && useCloudConnection;
    const payload = await this.adapter.message.buildPayload(
      duid,
      protocol,
      messageID,
      method,
      params,
      secure,
      photo,
      b01Q10Dps ? { b01Q10Dps } : {}
    );
    const roborockMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      protocol,
      timestamp,
      payload
    );

    if (roborockMessage) {
      return new Promise((resolve, reject) => {
        if (
          !deviceOnline &&
          (useCloudConnection || !localConnectionState) &&
          !allowOfflineCloudSend
        ) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "device-offline",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Device ${duid} offline. Not sending for method ${method} request!`
          );
          reject(
            new Error(
              `Device ${duid} is offline. Not sending method ${method} request.`
            )
          );
        } else if (!mqttConnectionState && useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastTransport: "cloud",
            lastCommandMethod: method,
            lastTransportReason: cloudOnlyConnection
              ? "cloud-only-mqtt-unavailable"
              : "mqtt-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Cloud connection not available. Not sending for method ${method} request!`
          );
          reject(
            new Error(
              `Cloud connection not available. Not sending method ${method} request.`
            )
          );
        } else if (!localConnectionState && !useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "local-socket-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Adapter not connect locally to robot ${duid}. Not sending for method ${method} request!`
          );
          reject(
            new Error(
              `Local connection not available for ${duid}. Not sending method ${method} request.`
            )
          );
        } else if (b01Q10Dps) {
          // The Q10 dialect is fire-and-forget: it defines no reply, so there is
          // no msgId to correlate and no response to wait for. Resolving here
          // confirms the write left this plugin, NOT that the robot acted on it.
          // A pending request and a timeout would only guarantee a false error
          // on a perfectly healthy link, which is exactly issue #10.
          if (useCloudConnection) {
            this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "cloud",
              lastTransportReason: "b01-q10-fire-and-forget",
              lastCommandMethod: method,
            });
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using cloud connection`
            );
          } else {
            const lengthBuffer = Buffer.alloc(4);
            lengthBuffer.writeUInt32BE(roborockMessage.length, 0);
            this.adapter.localConnector.sendMessage(
              duid,
              Buffer.concat([lengthBuffer, roborockMessage])
            );
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "local",
              lastTransportReason: "b01-q10-fire-and-forget",
              lastCommandMethod: method,
            });
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using local connection`
            );
          }
          this.adapter.log.debug(
            `Published B01 Q10 datapoint write for ${duid} with ${payload}. The Q10 dialect is fire-and-forget, so this is a publish confirmation and not a robot acknowledgement; no reply is expected.`
          );
          resolve(["ok"]);
        } else {
          // setup Timeout
          const requestTimeout = getRequestTimeout(
            method,
            options.requestTimeoutMs
          );
          const timeoutSeconds = Math.round(requestTimeout / 1000);
          const timeout = this.adapter.setTimeout(() => {
            this.adapter.pendingRequests.delete(messageID);
            this.adapter.localConnector.clearChunkBuffer(duid);
            if (useCloudConnection) {
              reject(
                new Error(
                  `Cloud request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds. MQTT connection state: ${mqttConnectionState}`
                )
              );
            } else {
              reject(
                new Error(
                  `Local request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds Local connect state: ${localConnectionState}`
                )
              );
            }
          }, requestTimeout);

          // Store request with resolve and reject functions
          this.adapter.pendingRequests.set(messageID, {
            resolve,
            reject,
            timeout,
          });

          if (useCloudConnection) {
            if (!deviceOnline && allowOfflineCloudSend) {
              this.adapter.log.debug(
                `Device ${duid} is marked offline, but sending method ${method} via cloud because the command explicitly allows offline cloud delivery.`
              );
            }
            this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
            const lastTransportReason =
              [
                {
                  condition: !deviceOnline && allowOfflineCloudSend,
                  reason: "offline-cloud-command",
                },
                { condition: secure, reason: "secure-command" },
                { condition: photo, reason: "photo-command" },
                { condition: cloudOnlyConnection, reason: "cloud-only-mode" },
                {
                  condition: preferCloudConnection,
                  reason: "preferred-cloud-command",
                },
                { condition: remoteConnection, reason: "remote-device" },
                {
                  condition: method == "get_network_info",
                  reason: "network-info-cloud-only",
                },
              ].find((entry) => entry.condition)?.reason ?? "cloud-request";
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "cloud",
              lastTransportReason,
              lastCommandMethod: method,
            });
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using cloud connection`
            );
            //client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${duid}`, roborockMessage, { qos: 1 });
            // this.adapter.log.debug(`Promise for messageID ${messageID} created. ${this.adapter.message._decodeMsg(roborockMessage, duid).payload}`);
          } else {
            const lengthBuffer = Buffer.alloc(4);
            lengthBuffer.writeUInt32BE(roborockMessage.length, 0);

            const fullMessage = Buffer.concat([lengthBuffer, roborockMessage]);
            this.adapter.localConnector.sendMessage(duid, fullMessage);
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "local",
              lastTransportReason: "local-request",
              lastCommandMethod: method,
            });
            // this.adapter.log.debug(`sent fullMessage: ${fullMessage.toString("hex")}`);
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using local connection`
            );
          }
        }
      }).finally(() => {
        this.adapter.log.debug(
          `Size of message queue: ${this.adapter.pendingRequests.size}`
        );
      });
    } else {
      this.adapter.catchError(
        "Failed to build buildRoborockMessage!",
        "function sendRequest",
        duid
      );
    }
  }
}

module.exports = {
  messageQueueHandler,
  getRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT,
};
