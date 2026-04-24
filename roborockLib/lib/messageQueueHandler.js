// @ts-check
"use strict";

const requestTimeout = 10000; // 10s

/**
 * @typedef {Object} PendingRequest
 * @property {(value: unknown) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {ReturnType<typeof setTimeout>} timeout
 */

/**
 * @typedef {Object} TransportDiagnosticsUpdate
 * @property {"cloud" | "local"} [lastTransport]
 * @property {string} [lastTransportReason]
 * @property {string} [lastCommandMethod]
 */

/**
 * @typedef {Object} MessageBuilder
 * @property {(duid: string, protocol: number, messageID: number, method: string, params: unknown[], secure: boolean, photo: boolean) => Promise<unknown>} buildPayload
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
 * @typedef {Object} MessageQueueAdapter
 * @property {(duid: string) => Promise<boolean>} isRemoteDevice
 * @property {(duid: string) => Promise<string>} getRobotVersion
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
 * @property {(message: string, location: string, duid?: string) => void} catchError
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
   * @returns {Promise<unknown | undefined>}
   */
  async sendRequest(duid, method, params, secure = false, photo = false) {
    const remoteConnection = await this.adapter.isRemoteDevice(duid);
    const version = await this.adapter.getRobotVersion(duid);

    const deviceOnline = await this.adapter.onlineChecker(duid);
    const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    const localConnectionState = this.adapter.localConnector.isConnected(duid);

    let useCloudConnection =
      remoteConnection || secure || photo || method == "get_network_info";
    if (!useCloudConnection && !localConnectionState && mqttConnectionState) {
      useCloudConnection = true;
      await this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "cloud",
        lastTransportReason: "local-unavailable-fallback",
        lastCommandMethod: method,
      });
      this.adapter.log.info(
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
    const payload = await this.adapter.message.buildPayload(
      duid,
      protocol,
      messageID,
      method,
      params,
      secure,
      photo
    );
    const roborockMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      protocol,
      timestamp,
      payload
    );

    if (roborockMessage) {
      return new Promise((resolve, reject) => {
        if (!deviceOnline) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "device-offline",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Device ${duid} offline. Not sending for method ${method} request!`
          );
          reject();
        } else if (!mqttConnectionState && useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "mqtt-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Cloud connection not available. Not sending for method ${method} request!`
          );
          reject();
        } else if (!localConnectionState && !useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "local-socket-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Adapter not connect locally to robot ${duid}. Not sending for method ${method} request!`
          );
          reject();
        } else {
          // setup Timeout
          const timeout = this.adapter.setTimeout(() => {
            this.adapter.pendingRequests.delete(messageID);
            this.adapter.localConnector.clearChunkBuffer(duid);
            if (useCloudConnection) {
              reject(
                new Error(
                  `Cloud request with id ${messageID} with method ${method} timed out after 10 seconds. MQTT connection state: ${mqttConnectionState}`
                )
              );
            } else {
              reject(
                new Error(
                  `Local request with id ${messageID} with method ${method} timed out after 10 seconds Local connect state: ${localConnectionState}`
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
            this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "cloud",
              lastTransportReason: secure
                ? "secure-command"
                : photo
                  ? "photo-command"
                  : remoteConnection
                    ? "remote-device"
                    : method == "get_network_info"
                      ? "network-info-cloud-only"
                      : "cloud-request",
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
};
