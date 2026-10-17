"use strict";

const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const net = require("net");
const dgram = require("dgram");

const server = dgram.createSocket("udp4");
const PORT = 58866;
const TIMEOUT = 5000; // 5 Sekunden Timeout
const LOCAL_RECONNECT_DELAY_MS = 60000;
const LOCAL_CONNECT_TIMEOUT_MS = 4000;
// How long the local protocol probe waits for an answer to its L01 HELLO.
const PROBE_TIMEOUT = 3000;
// PING spacing for L01 devices, which close a local connection after 60 s
// without traffic.
const KEEPALIVE_INTERVAL = 30000;

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

// Some adapters provide their own setTimeout/clearTimeout (e.g. to keep timers
// on the same event loop / for testability). Fall back to the global timer
// functions when the adapter doesn't provide them.
function getTimerFns(adapter) {
  return {
    setTimer:
      typeof adapter.setTimeout === "function"
        ? adapter.setTimeout.bind(adapter)
        : setTimeout,
    clearTimer:
      typeof adapter.clearTimeout === "function"
        ? adapter.clearTimeout.bind(adapter)
        : clearTimeout,
  };
}

// Local TCP frames are sent with a 4-byte big-endian length prefix.
function withLengthPrefix(message) {
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(message.length, 0);
  return Buffer.concat([lengthBuffer, message]);
}

// Random value in [10000, 32767], the range used for the L01 connect_nonce.
function randomNonce() {
  return 10000 + Math.floor(Math.random() * 22768);
}

class EnhancedSocket extends net.Socket {
  constructor(options) {
    super(options);
    this.connected = false;
    this.chunkBuffer = Buffer.alloc(0);
    this.keepaliveTimer = null;

    this.on("connect", () => {
      this.connected = true;
    });

    this.on("close", () => {
      this.connected = false;
      this.stopKeepalive();
    });

    this.on("error", () => {
      this.connected = false;
    });

    this.on("end", () => {
      this.connected = false;
    });
  }

  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

const localMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint16("protocol")
  .uint16("payloadLen")
  .buffer("payload", {
    length: "payloadLen",
  })
  .uint32("crc32");

const shortMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint32("random")
  .uint32("timestamp")
  .uint16("protocol");

class localConnector {
  constructor(adapter) {
    this.adapter = adapter;

    this.localClients = {};
    this.l01HandshakeWaiters = new Map();
    this.reconnectTimers = new Map();
    this.connectPromises = new Map();
  }

  clearReconnectTimer(duid) {
    const timer = this.reconnectTimers.get(duid);
    if (!timer) {
      return;
    }

    if (typeof this.adapter.clearTimeout === "function") {
      this.adapter.clearTimeout(timer);
    } else {
      clearTimeout(timer);
    }
    this.reconnectTimers.delete(duid);
  }

  scheduleReconnect(duid, ip, delayMs = LOCAL_RECONNECT_DELAY_MS) {
    this.clearReconnectTimer(duid);
    const { setTimer } = getTimerFns(this.adapter);
    const timer = setTimer(async () => {
      this.reconnectTimers.delete(duid);
      await this.createClient(duid, ip);
    }, delayMs);
    this.reconnectTimers.set(duid, timer);
  }

  async ensureConnected(duid, ip) {
    if (!ip) {
      return false;
    }

    if (this.isConnected(duid)) {
      return true;
    }

    const pending = this.connectPromises.get(duid);
    if (pending) {
      await pending;
      return Boolean(this.isConnected(duid));
    }

    const connectPromise = this.createClient(duid, ip)
      .catch((error) => {
        this.adapter.log.debug(
          `Immediate local reconnect failed for ${duid}: ${error.message || error}`
        );
      })
      .finally(() => {
        this.connectPromises.delete(duid);
      });

    this.connectPromises.set(duid, connectPromise);
    await connectPromise;
    return Boolean(this.isConnected(duid));
  }

  async resetClient(duid, reason = "local-client-reset") {
    this.clearReconnectTimer(duid);
    const client = this.localClients[duid];
    if (!client) {
      return;
    }

    if (this.localClients[duid] === client) {
      delete this.localClients[duid];
    }

    const waiter = this.l01HandshakeWaiters.get(duid);
    if (waiter) {
      this.adapter.clearTimeout(waiter.timeout);
      this.l01HandshakeWaiters.delete(duid);
      waiter.reject(
        new Error(`TCP client reset during L01 handshake for ${duid}`)
      );
    }

    this.adapter.localL01Nonces.delete(duid);
    client.destroy();
    await this.adapter.updateTransportDiagnostics(duid, {
      tcpConnectionState: "disconnected",
      lastTransport: "cloud",
      lastTransportReason: reason,
    });
  }

  async markLocalConnected(duid) {
    if (this.adapter.remoteDevices?.delete(duid)) {
      this.adapter.log.debug(
        `Local TCP connected for ${duid}; clearing remote fallback marker.`
      );
    }

    await this.adapter.updateTransportDiagnostics(duid, {
      tcpConnectionState: "connected",
      isRemote: false,
      remoteReason: null,
      lastTransport: "local",
      lastTransportReason: "tcp-connected",
    });
  }

  async createClient(duid, ip) {
    this.clearReconnectTimer(duid);
    const existingClient = this.localClients[duid];
    if (existingClient?.connected || existingClient?.connecting) {
      return;
    }

    // Some firmwares report pv "1.0" in HomeData but only speak L01 on the
    // LAN and silently drop 1.0 frames. Probe over a throwaway connection: a
    // device that answers an L01 HELLO gets L01 for all its local traffic.
    // 1.0 devices don't answer, which costs them up to PROBE_TIMEOUT per
    // connect. Only an L01 answer is remembered, so a device that switches
    // to L01 with a firmware update is picked up on its next reconnect.
    try {
      await this.detectLocalVersion(duid, ip);
    } catch (error) {
      this.adapter.log.debug(
        `Local protocol probe failed for ${duid}: ${error.message}`
      );
    }

    const client = new EnhancedSocket();
    await this.adapter.updateTransportDiagnostics(duid, {
      localIp: ip,
      tcpConnectionState: "connecting",
      lastTransport: "local-pending",
    });

    // Wrap the connect method in a promise to await its completion
    await new Promise((resolve, reject) => {
      let settled = false;
      const { setTimer, clearTimer } = getTimerFns(this.adapter);
      const timeout = setTimer(() => {
        if (settled) {
          return;
        }

        settled = true;
        client.destroy();
        reject(
          new Error(
            `Timed out connecting local TCP client for ${duid} at ${ip}`
          )
        );
      }, LOCAL_CONNECT_TIMEOUT_MS);
      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimer(timeout);
        callback(value);
      };

      client
        .connect(58867, ip, async () => {
          this.adapter.log.debug(`tcp client for ${duid} connected`);
          await this.markLocalConnected(duid);
          this.ensureL01Handshake(duid).catch((error) => {
            this.adapter.log.debug(
              `L01 handshake on connect failed for ${duid}: ${error.message}`
            );
          });
          this.startKeepalive(duid, client).catch((error) => {
            this.adapter.log.debug(
              `Keepalive setup failed for ${duid}: ${error.message}`
            );
          });
          finish(resolve);
        })
        .on("error", (error) => {
          this.adapter.log.debug(
            `error on tcp client for ${duid}. ${error.message}`
          );
          finish(reject, error);
        });
    }).catch(async (error) => {
      const online = await this.adapter.onlineChecker(duid);
      await this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "connect-failed",
        lastTransport: "cloud",
        lastTransportReason: online
          ? "tcp-connect-failed"
          : "device-offline-during-connect",
      });
      if (online) {
        // if the device is online, we can assume that the device is a remote device
        this.adapter.log.debug(
          `error on tcp client for ${duid}. Marking this device as remote device. Connecting via MQTT instead ${error.message}`
        );
        this.adapter.remoteDevices.add(duid);
        await this.adapter.updateTransportDiagnostics(duid, {
          isRemote: true,
          remoteReason: "marked-remote-after-connect-failure",
        });
        // this.adapter.catchError(`Failed to create tcp client: ${error.stack}`, `function createClient`, duid);
      }
    });

    client.on("data", async (message) => {
      try {
        if (client.chunkBuffer.length == 0) {
          this.adapter.log.debug(`new chunk started`);
          client.chunkBuffer = message;
        } else {
          this.adapter.log.debug(`new chunk received`);
          client.chunkBuffer = Buffer.concat([client.chunkBuffer, message]);
        }
        // this.adapter.log.debug(`new chunk received: ${message.toString("hex")}`);

        let offset = 0;
        if (this.checkComplete(client.chunkBuffer)) {
          this.adapter.log.debug(
            `Chunk buffer data is complete. Processing...`
          );
          // this.adapter.log.debug(`chunkBuffer: ${client.chunkBuffer.toString("hex")}`);
          while (offset + 4 <= client.chunkBuffer.length) {
            const segmentLength = client.chunkBuffer.readUInt32BE(offset);
            const currentBuffer = client.chunkBuffer.subarray(
              offset + 4,
              offset + segmentLength + 4
            );
            // Short, header-only handshake frames carry no encrypted payload:
            // the L01 HELLO_RESPONSE is 21 bytes (version+seq+random+timestamp+
            // protocol+CRC32); a bare 17-byte header may also appear. Route both
            // to the shortMessage handler below; anything larger is a data
            // message with an encrypted payload.
            if (segmentLength != 17 && segmentLength != 21) {
              const data = this.adapter.message._decodeMsg(currentBuffer, duid);
              if (!data) {
                offset += 4 + segmentLength;
                continue;
              }

              if (data.protocol == 4) {
                const dps = JSON.parse(data.payload).dps;

                if (dps) {
                  const _102 = JSON.stringify(dps["102"]);
                  const parsed_102 = JSON.parse(JSON.parse(_102));
                  const id = parsed_102.id;
                  const result = parsed_102.result;

                  if (this.adapter.pendingRequests.has(id)) {
                    this.adapter.log.debug(
                      `Local message with protocol 4 and id ${id} received. Result: ${JSON.stringify(result)}`
                    );
                    const { resolve, timeout } =
                      this.adapter.pendingRequests.get(id);
                    this.adapter.clearTimeout(timeout);
                    this.adapter.pendingRequests.delete(id);
                    resolve(result);

                    if (this.adapter.deviceNotify !== undefined) {
                      this.adapter.deviceNotify("LocalMessage", {
                        duid,
                        payload: result,
                      });
                    }
                  }
                }
              }
            } else {
              try {
                const shortMessage = shortMessageParser.parse(currentBuffer);
                // HELLO_RESPONSE (protocol 1) echoing our seq=1 HELLO; its
                // random field is the ack_nonce.
                if (
                  shortMessage.version == "L01" &&
                  shortMessage.protocol == 1 &&
                  shortMessage.seq == 1
                ) {
                  const currentNonces =
                    this.adapter.localL01Nonces.get(duid) || {};
                  this.adapter.localL01Nonces.set(duid, {
                    connectNonce: currentNonces.connectNonce,
                    ackNonce: shortMessage.random,
                  });

                  const waiter = this.l01HandshakeWaiters.get(duid);
                  if (waiter) {
                    this.adapter.clearTimeout(waiter.timeout);
                    this.l01HandshakeWaiters.delete(duid);
                    waiter.resolve(true);
                  }
                }
              } catch (error) {
                this.adapter.log.debug(
                  `Failed parsing short local message for ${duid}: ${error.message}`
                );
              }
            }
            offset += 4 + segmentLength;
          }
          this.clearChunkBuffer(duid);
        }
      } catch (error) {
        this.adapter.catchError(
          `Failed to create tcp client: ${error.stack}`,
          `function createClient`,
          duid
        );
      }
    });

    client.on("close", () => {
      if (this.localClients[duid] !== client) {
        return;
      }
      this.adapter.log.debug(
        `tcp client for ${duid} disconnected, attempting to reconnect...`
      );
      this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "disconnected",
        lastTransport: "cloud",
        lastTransportReason: "tcp-disconnected",
      });
      const waiter = this.l01HandshakeWaiters.get(duid);
      if (waiter) {
        this.adapter.clearTimeout(waiter.timeout);
        this.l01HandshakeWaiters.delete(duid);
        waiter.reject(
          new Error(`TCP client closed during L01 handshake for ${duid}`)
        );
      }
      this.adapter.localL01Nonces.delete(duid);
      this.scheduleReconnect(duid, ip);
      client.connected = false;
    });

    client.on("error", (error) => {
      this.adapter.log.debug(
        `error on tcp client for ${duid}. ${error.message}`
      );
      this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "error",
        lastTransportReason: `tcp-error: ${error.message}`,
      });
    });

    this.localClients[duid] = client;
  }

  checkComplete(buffer) {
    let totalLength = 0;
    let offset = 0;

    while (offset + 4 <= buffer.length) {
      const segmentLength = buffer.readUInt32BE(offset);
      totalLength += 4 + segmentLength;
      offset += 4 + segmentLength;

      if (offset > buffer.length) {
        return false; // Data is not complete yet
      }
    }

    return totalLength <= buffer.length;
  }

  clearChunkBuffer(duid) {
    if (this.localClients[duid]) {
      this.localClients[duid].chunkBuffer = Buffer.alloc(0);
    }
  }

  sendMessage(duid, message) {
    const client = this.localClients[duid];
    if (client) {
      client.write(message);
    }
  }

  isConnected(duid) {
    if (this.localClients[duid]) {
      return this.localClients[duid].connected;
    }
  }

  // Probe whether a pv-"1.0" device actually speaks L01 on the LAN, over a
  // throwaway connection. See createClient for the rationale.
  async detectLocalVersion(duid, ip, port = 58867) {
    if (this.adapter.localVersions.has(duid)) {
      return;
    }
    if ((await this.adapter.getRobotVersion(duid)) != "1.0") {
      return;
    }

    const hello = await this.adapter.message.buildRoborockMessage(
      duid,
      0,
      Math.floor(Date.now() / 1000),
      Buffer.alloc(0),
      { version: "L01", seq: 1, random: randomNonce() }
    );

    const answersL01 = await new Promise((resolve) => {
      const probe = new net.Socket();
      const done = (result) => {
        clearTimeout(timer);
        probe.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT);
      probe.on("data", (data) => {
        done(data.length >= 7 && data.toString("latin1", 4, 7) == "L01");
      });
      probe.on("error", () => done(false));
      probe.on("close", () => done(false));
      probe.connect(port, ip, () => probe.write(withLengthPrefix(hello)));
    });

    if (answersL01) {
      this.adapter.localVersions.set(duid, "L01");
      this.adapter.log.info(
        `Robot ${duid} reports protocol 1.0 but answers L01 locally. Using L01 for the local connection.`
      );
    }
  }

  // A header-only PING (protocol 2, answered with protocol 3, which the data
  // handler ignores) every KEEPALIVE_INTERVAL keeps an L01 connection open.
  // 1.0 devices keep idle connections open and get no PING.
  async startKeepalive(duid, client) {
    if ((await this.adapter.getRobotVersion(duid, "local")) != "L01") {
      return;
    }
    // The connection may have closed while the version was looked up.
    if (!client.connected || client.keepaliveTimer) {
      return;
    }

    let pingSeq = 0x10000;
    client.keepaliveTimer = setInterval(async () => {
      try {
        const ping = await this.adapter.message.buildRoborockMessage(
          duid,
          2,
          Math.floor(Date.now() / 1000),
          Buffer.alloc(0),
          { seq: pingSeq++, random: randomNonce() }
        );
        if (ping && client.connected) {
          client.write(withLengthPrefix(ping));
        }
      } catch (error) {
        this.adapter.log.debug(
          `Keepalive ping failed for ${duid}: ${error.message}`
        );
      }
    }, KEEPALIVE_INTERVAL);
  }

  async ensureL01Handshake(duid) {
    const version = await this.adapter.getRobotVersion(duid, "local");
    if (version != "L01") {
      return;
    }

    const client = this.localClients[duid];
    if (!client || !client.connected) {
      return;
    }

    const existingNonces = this.adapter.localL01Nonces.get(duid);
    if (
      existingNonces &&
      typeof existingNonces.connectNonce == "number" &&
      typeof existingNonces.ackNonce == "number"
    ) {
      return;
    }

    // HELLO request: protocol 0 (HELLO_REQUEST), 21-byte header+CRC frame,
    // seq=1, a real timestamp, and random=connect_nonce. The robot replies
    // with a protocol-1 (HELLO_RESPONSE) frame whose random field is the
    // ack_nonce. Pick a stable connect_nonce in [10000, 32767] and store it
    // BEFORE sending, so the follow-up L01 data-message AAD reuses the exact
    // value the robot saw in the HELLO.
    const timestamp = Math.floor(Date.now() / 1000);
    const connectNonce = 10000 + Math.floor(Math.random() * 22768);
    this.adapter.localL01Nonces.set(duid, {
      connectNonce,
      ackNonce: undefined,
    });

    const handshakeMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      0,
      timestamp,
      Buffer.alloc(0),
      { seq: 1, random: connectNonce }
    );
    if (!handshakeMessage) {
      throw new Error(`Failed to build HELLO handshake message for ${duid}`);
    }

    if (this.l01HandshakeWaiters.has(duid)) {
      const waiter = this.l01HandshakeWaiters.get(duid);
      this.adapter.clearTimeout(waiter.timeout);
      this.l01HandshakeWaiters.delete(duid);
    }

    const handshakePromise = new Promise((resolve, reject) => {
      const timeout = this.adapter.setTimeout(() => {
        this.l01HandshakeWaiters.delete(duid);
        reject(
          new Error(`Timed out waiting for L01 handshake response for ${duid}`)
        );
      }, 3000);

      this.l01HandshakeWaiters.set(duid, { resolve, reject, timeout });
    });

    client.write(withLengthPrefix(handshakeMessage));

    await handshakePromise;
  }

  async getLocalDevices() {
    return new Promise((resolve, reject) => {
      const devices = {};

      server.on("message", (msg) => {
        const parsedMessage = localMessageParser.parse(msg);
        const decodedMessage = this.decryptECB(
          parsedMessage.payload,
          BROADCAST_TOKEN
        ); // this might be decryptCBC for A01. Haven't checked this yet

        if (decodedMessage == null) {
          this.adapter.log.debug(`getLocalDevices: decodedMessage is null`);
          return;
        }

        const parsedDecodedMessage = JSON.parse(decodedMessage);
        this.adapter.log.debug(
          `getLocalDevices parsedDecodedMessage: ${JSON.stringify(parsedDecodedMessage)}`
        );

        if (parsedDecodedMessage) {
          const localKey = this.adapter.localKeys.get(
            parsedDecodedMessage.duid
          );
          this.adapter.log.debug(
            `getLocalDevices localKey present: ${Boolean(localKey)}`
          );

          if (localKey) {
            // if there's no localKey, decryption cannot work. For example when the found robot is not associated with a roborock account
            if (!devices[parsedDecodedMessage.duid]) {
              devices[parsedDecodedMessage.duid] = parsedDecodedMessage.ip;
              this.adapter.updateTransportDiagnostics(
                parsedDecodedMessage.duid,
                {
                  localIp: parsedDecodedMessage.ip,
                  localDiscoveryState: "broadcast-detected",
                  lastTransportReason: "udp-broadcast-discovery",
                }
              );
            }
          }
        }
      });

      server.on("error", (error) => {
        this.adapter.catchError(`Discover server error: ${error.stack}`);
        server.close();
        reject(error);
      });

      server.bind(PORT);

      this.localDevicesTimeout = this.adapter.setTimeout(() => {
        server.close();

        resolve(devices);
      }, TIMEOUT);
    });
  }

  safeRemovePkcs7(buf) {
    if (!buf || buf.length === 0) return Buffer.alloc(0);
    const pad = buf[buf.length - 1];
    // 僅在 1..16 且最後 pad 個 byte 都等於 pad 時才移除
    if (pad > 0 && pad <= 16) {
      for (let i = 0; i < pad; i++) {
        if (buf[buf.length - 1 - i] !== pad) return buf; // padding 形狀不對，視為無 padding
      }
      return buf.slice(0, buf.length - pad);
    }
    return buf; // 看起來沒有標準 PKCS#7 padding
  }

  decryptECB(encrypted, aesKey) {
    // --- 1) Key/輸入檢查 ---
    const key = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey);
    if (key.length !== 16) {
      // AES-128 需要 16 bytes 的 key
      return null;
    }

    const input = Buffer.isBuffer(encrypted)
      ? encrypted
      : Buffer.from(encrypted, "latin1"); // "binary" 等同 latin1
    if (input.length === 0 || input.length % 16 !== 0) {
      // 密文長度不是 16 的倍數，多半是封包不完整；丟回 null 讓上層忽略本次
      return null;
    }

    try {
      // --- 2) 固定用 Buffer，關閉自動 padding（你要自己移除） ---
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(false);

      const decryptedBuf = Buffer.concat([
        decipher.update(input),
        decipher.final(),
      ]);
      const unpadded = safeRemovePkcs7(decryptedBuf);

      // 若原協定內容是 UTF-8，這裡再轉字串；否則直接回傳 Buffer 讓上層處理
      return unpadded.toString("utf8");
    } catch (err) {
      // 例如 wrong final block length、key 不對等情況
      // 這裡不要讓程式炸掉，直接忽略這個封包
      // 你也可以在這裡做一次 debug log
      // console.debug("decryptECB error:", err);
      return null;
    }
  }

  clearLocalDevicedTimeout() {
    if (this.localDevicesTimeout) {
      this.adapter.clearTimeout(this.localDevicesTimeout);
    }
  }
}

module.exports = {
  localConnector,
};
