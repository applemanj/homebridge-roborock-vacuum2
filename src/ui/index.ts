import crypto from "crypto";
import path from "path";
import fs from "fs";
import { encryptSession } from "../crypto";

const roborockAuth = require("../../roborockLib/lib/roborockAuth");

// Type definition for HomebridgePluginUiServer to maintain type safety
interface IHomebridgePluginUiServer {
  homebridgeStoragePath?: string;
  onRequest(path: string, handler: (payload: any) => Promise<any>): void;
  ready(): void;
}

type HomebridgePluginUiServerConstructor = new () => IHomebridgePluginUiServer;

class RoborockUiServer {
  private homebridgePluginUiServer: IHomebridgePluginUiServer;
  private homebridgeStoragePath?: string;

  constructor(HomebridgePluginUiServer: HomebridgePluginUiServerConstructor) {
    this.homebridgePluginUiServer = new HomebridgePluginUiServer();
    this.homebridgeStoragePath =
      this.homebridgePluginUiServer.homebridgeStoragePath;

    this.homebridgePluginUiServer.onRequest(
      "/auth/send-2fa-email",
      this.sendTwoFactorEmail.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/verify-2fa-code",
      this.verifyTwoFactorCode.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/login",
      this.loginWithPassword.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/logout",
      this.logout.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/diagnostics/state",
      this.getDiagnostics.bind(this)
    );

    this.homebridgePluginUiServer.ready();
  }

  private getStoragePath(): string {
    return this.homebridgeStoragePath || process.cwd();
  }

  private async getClientId(): Promise<string> {
    const storagePath = this.getStoragePath();
    if (storagePath) {
      const clientIdPath = path.join(storagePath, "roborock.clientID");
      try {
        const stored = JSON.parse(fs.readFileSync(clientIdPath, "utf8"));
        if (stored && stored.val) {
          return stored.val;
        }
      } catch (error) {
        // Ignore and generate a new client ID.
      }
      const clientId = crypto.randomUUID();
      fs.mkdirSync(storagePath, { recursive: true });
      fs.writeFileSync(
        clientIdPath,
        JSON.stringify({ val: clientId, ack: true }, null, 2),
        "utf8"
      );
      return clientId;
    }

    return crypto.randomUUID();
  }

  private async buildLoginApi(config: Record<string, any>) {
    const clientID = await this.getClientId();
    return roborockAuth.createLoginApi({
      baseURL: config.baseURL || "usiot.roborock.com",
      username: config.email,
      clientID,
      language: "en",
    });
  }

  private async sendTwoFactorEmail(payload: {
    email?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    if (!email) {
      return { ok: false, message: "Email is required." };
    }

    try {
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
      });
      await roborockAuth.requestEmailCode(loginApi, email);
      return { ok: true, message: "Verification email sent." };
    } catch (error: any) {
      console.error("2FA email request failed:", error?.message || error);
      return {
        ok: false,
        message: error?.message || "Failed to send verification email.",
      };
    }
  }

  private async verifyTwoFactorCode(payload: {
    email?: string;
    code: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    if (!email) {
      return { ok: false, message: "Email is required." };
    }

    if (!payload.code) {
      return { ok: false, message: "Verification code is required." };
    }

    let loginResult;
    try {
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
      });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      const region = roborockAuth.getRegionConfig(
        payload.baseURL || "usiot.roborock.com"
      );
      loginResult = await roborockAuth.loginWithCode(loginApi, {
        email,
        code: payload.code,
        country: region.country,
        countryCode: region.countryCode,
        k: signData.k,
        s: nonce,
      });
    } catch (error: any) {
      console.error(
        "2FA verification request failed:",
        error?.message || error
      );
      return { ok: false, message: error?.message || "Verification failed." };
    }

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      const encrypted = encryptSession(loginResult.data, this.getStoragePath());
      return {
        ok: true,
        message: "Login completed and token saved.",
        encryptedToken: encrypted,
      };
    }

    console.error("2FA verification failed:", loginResult);
    return { ok: false, message: loginResult?.msg || "Verification failed." };
  }

  private async loginWithPassword(payload: {
    email?: string;
    password?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    const password = payload.password;

    if (!email || !password) {
      return { ok: false, message: "Email and password are required." };
    }

    let loginResult;
    try {
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
      });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      loginResult = await roborockAuth.loginByPassword(loginApi, {
        email,
        password,
        k: signData.k,
        s: nonce,
      });
    } catch (error: any) {
      console.error("Login request failed:", error?.message || error);
      return { ok: false, message: error?.message || "Login failed." };
    }

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      const encrypted = encryptSession(loginResult.data, this.getStoragePath());
      return {
        ok: true,
        message: "Login successful. Token saved.",
        encryptedToken: encrypted,
      };
    }

    if (loginResult && loginResult.code === 2031) {
      return {
        ok: false,
        twoFactorRequired: true,
        message: "Two-factor authentication required.",
      };
    }

    console.error("Login failed:", loginResult);
    return {
      ok: false,
      message: loginResult?.msg || "Login failed. Check your credentials.",
    };
  }

  private async logout() {
    const storagePath = this.getStoragePath();
    if (!storagePath) {
      return { ok: true, message: "Logged out. Token cleared." };
    }

    const userDataPath = path.join(storagePath, "roborock.UserData");
    try {
      if (fs.existsSync(userDataPath)) {
        fs.unlinkSync(userDataPath);
      }
    } catch (error) {
      // Ignore file removal errors.
    }

    return { ok: true, message: "Logged out. Token cleared." };
  }

  private async getDiagnostics() {
    try {
      const storagePath = this.getStoragePath();
      const homeDataState = this.readJsonFile(
        path.join(storagePath, "roborock.HomeData")
      );
      const userDataState = this.readJsonFile(
        path.join(storagePath, "roborock.UserData")
      );
      const transportDiagnosticsState = this.readJsonFile(
        path.join(storagePath, "roborock.TransportDiagnostics")
      );
      const homeData = this.parseStatePayload(homeDataState?.val);
      const transportDiagnostics =
        this.parseStatePayload(transportDiagnosticsState?.val) || {};

      const products = Array.isArray(homeData?.products)
        ? homeData.products
        : [];
      const devices = this.collectDevices(homeData);
      const diagnostics = devices.map((device: Record<string, any>) => {
        const product = products.find(
          (entry: Record<string, any>) => entry.id == device.productId
        );
        const deviceModel = this.firstNonEmptyString([
          device.model,
          device.productModel,
          device.productCode,
          device.modelId,
        ]);
        const productModel = this.firstNonEmptyString([
          product?.model,
          product?.productModel,
          product?.productCode,
          product?.modelId,
        ]);
        const resolvedModel = deviceModel || productModel || "unknown";
        const localKey = this.firstNonEmptyString([device.localKey]);
        const transport = transportDiagnostics[device.duid] || {};
        const connection = this.describeConnectionState(
          device,
          transport,
          Boolean(localKey)
        );

        return {
          name: device.name || device.duid || "Unknown device",
          duid: device.duid || "",
          serialNumber: device.sn || null,
          productId: device.productId || null,
          resolvedModel,
          deviceModel: deviceModel || null,
          productModel: productModel || null,
          hasLocalKey: Boolean(localKey),
          connectionStatus: connection.status,
          connectionHealth: connection.health,
          connectionHint: connection.hint,
          localConnectivityState: connection.status,
          localIp: transport.localIp || null,
          localDiscoveryState: transport.localDiscoveryState || null,
          tcpConnectionState: transport.tcpConnectionState || null,
          isRemote: transport.isRemote ?? null,
          remoteReason: transport.remoteReason || null,
          lastTransport: transport.lastTransport || null,
          lastTransportReason: transport.lastTransportReason || null,
          lastCommandMethod: transport.lastCommandMethod || null,
          transportUpdatedAt: transport.updatedAt || null,
          homeDataSource:
            Array.isArray(homeData?.receivedDevices) &&
            homeData.receivedDevices.some(
              (entry: Record<string, any>) => entry.duid === device.duid
            )
              ? "receivedDevices"
              : "devices",
          online: device.online ?? null,
        };
      });

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        pluginVersion: this.getPackageVersion(),
        nodeVersion: process.version,
        storagePath,
        hasEncryptedToken: Boolean(userDataState?.val),
        hasHomeData: Boolean(homeData),
        deviceCount: diagnostics.length,
        devices: diagnostics,
      };
    } catch (error: any) {
      return {
        ok: false,
        message: error?.message || "Failed to load diagnostics.",
      };
    }
  }

  private buildNonce(): string {
    return crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
  }

  private readJsonFile(filePath: string): any | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  private parseStatePayload(value: unknown): Record<string, any> | null {
    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private collectDevices(
    homeData: Record<string, any> | null
  ): Record<string, any>[] {
    if (!homeData) {
      return [];
    }

    const devices = Array.isArray(homeData.devices) ? homeData.devices : [];
    const receivedDevices = Array.isArray(homeData.receivedDevices)
      ? homeData.receivedDevices
      : [];
    return [...devices, ...receivedDevices];
  }

  private firstNonEmptyString(values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }

  private describeConnectionState(
    device: Record<string, any>,
    transport: Record<string, any>,
    hasLocalCredentials: boolean
  ): { status: string; health: "good" | "warn"; hint: string } {
    const tcpState = transport.tcpConnectionState;
    const lastTransportReason =
      transport.lastTransportReason || transport.remoteReason || null;
    const hasLocalIp = Boolean(transport.localIp);

    if (tcpState === "connected") {
      return {
        status: "Local connected",
        health: "good",
        hint: "The plugin has an active LAN TCP connection to this vacuum.",
      };
    }

    if (device.online === false || lastTransportReason === "device-offline") {
      return {
        status: "Device offline",
        health: "warn",
        hint: hasLocalCredentials
          ? "Roborock currently reports this vacuum offline. Local credentials are available, but the plugin cannot use them until the vacuum wakes up and rejoins Wi-Fi."
          : "Roborock currently reports this vacuum offline, and no local credentials were found for LAN control.",
      };
    }

    if (transport.lastTransport === "cloud") {
      return {
        status: "Cloud fallback",
        health: "warn",
        hint: hasLocalCredentials
          ? "The plugin has local credentials but the last command used Roborock cloud transport, usually because LAN TCP was not connected at that moment."
          : "The last command used Roborock cloud transport because local LAN credentials are not available.",
      };
    }

    if (hasLocalCredentials && hasLocalIp) {
      return {
        status: "Ready for local connection",
        health: "warn",
        hint: "The plugin has local credentials and a discovered IP address, but no active LAN TCP connection is currently cached.",
      };
    }

    if (hasLocalCredentials) {
      return {
        status: "Local credentials available",
        health: "warn",
        hint: "The plugin has the credential needed for LAN control, but it has not discovered or connected to the vacuum locally yet.",
      };
    }

    return {
      status: "Cloud-only fallback likely",
      health: "warn",
      hint: "No local LAN credential was found for this vacuum, so the plugin will likely rely on Roborock cloud transport.",
    };
  }

  private getPackageVersion(): string {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")
      );
      return packageJson.version || "unknown";
    } catch {
      return "unknown";
    }
  }
}

// IMPORTANT: Use Function constructor to create a dynamic import that TypeScript won't transform
//
// Background: @homebridge/plugin-ui-utils v2+ is a pure ES module that cannot be loaded with require()
// in Node.js 18+. Normally we would use `await import('@homebridge/plugin-ui-utils')`, but because
// this project uses TypeScript with "module": "commonjs" in tsconfig.json, TypeScript transforms
// dynamic imports into require() calls in the compiled output, which defeats the purpose.
//
// Solution: Using the Function constructor prevents TypeScript from transforming the import statement.
// The Function constructor is evaluated at runtime, so TypeScript cannot statically analyze or transform it.
// This is the recommended workaround for ES module/CommonJS interop when using TypeScript with CommonJS output.
//
// Security note: This is safe because the module specifier is a hardcoded string literal, not user input.
(async () => {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  const { HomebridgePluginUiServer } = await dynamicImport(
    "@homebridge/plugin-ui-utils"
  );
  new RoborockUiServer(HomebridgePluginUiServer);
})();
