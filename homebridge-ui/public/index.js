const elements = {
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordRow: document.getElementById("password-row"),
  baseUrl: document.getElementById("base-url"),
  skipDevices: document.getElementById("skip-devices"),
  debugMode: document.getElementById("debug-mode"),
  code: document.getElementById("two-factor-code"),
  saveSettings: document.getElementById("save-settings"),
  login: document.getElementById("login"),
  logout: document.getElementById("logout"),
  send2fa: document.getElementById("send-2fa"),
  verify2fa: document.getElementById("verify-2fa"),
  twoFactorSection: document.getElementById("two-factor-section"),
  authStatus: document.getElementById("auth-status"),
  toastContainer: document.getElementById("toast-container"),
  copyDiagnostics: document.getElementById("copy-diagnostics"),
  refreshDiagnostics: document.getElementById("refresh-diagnostics"),
  diagnosticsSummary: document.getElementById("diagnostics-summary"),
  diagnosticsEmpty: document.getElementById("diagnostics-empty"),
  diagnosticsList: document.getElementById("diagnostics-list"),
};

const state = {
  hasEncryptedToken: false,
  hasPassword: false,
  lastDiagnostics: null,
};

function showToast(type, message) {
  if (
    window.homebridge &&
    window.homebridge.toast &&
    typeof window.homebridge.toast[type] === "function"
  ) {
    window.homebridge.toast[type](message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

async function request(path, body) {
  try {
    return await window.homebridge.request(path, body);
  } catch (error) {
    return { ok: false, message: error.message || "Request failed." };
  }
}

async function loadConfig() {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    updateAuthStatus(false, false);
    return;
  }

  const configs = await window.homebridge.getPluginConfig();
  const config = configs.find(
    (entry) => entry.platform === "RoborockVacuumPlatform"
  );
  if (!config) {
    updateAuthStatus(false, false);
    return;
  }

  if (config.email) {
    elements.email.value = config.email;
  }
  elements.baseUrl.value = normalizeBaseUrl(
    config.baseURL || "https://usiot.roborock.com"
  );
  if (config.skipDevices) {
    elements.skipDevices.value = config.skipDevices;
  }
  elements.debugMode.checked = Boolean(config.debugMode);

  state.hasEncryptedToken = Boolean(config.encryptedToken);
  state.hasPassword = Boolean(config.password);
  setLoggedInState(state.hasEncryptedToken, state.hasPassword);
  await loadDiagnostics();
}

function getEmail() {
  return elements.email.value.trim();
}

function getPassword() {
  return elements.password.value;
}

function getBaseUrl() {
  return elements.baseUrl.value;
}

function getSkipDevices() {
  return elements.skipDevices.value.trim();
}

function getDebugMode() {
  return Boolean(elements.debugMode.checked);
}

function getCode() {
  return elements.code.value.trim();
}

async function saveCredentials(showSuccess = false) {
  const email = getEmail();
  const password = getPassword();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const debugMode = getDebugMode();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const patch = {
    email,
    baseURL,
    skipDevices,
    debugMode,
  };

  if (password) {
    patch.password = password;
  }

  await updatePluginConfig(patch);

  if (password) {
    state.hasPassword = true;
  }

  if (showSuccess) {
    showToast("success", "Settings saved.");
  }

  updateAuthStatus(state.hasEncryptedToken, state.hasPassword);
}

async function login() {
  const email = getEmail();
  const password = getPassword();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const debugMode = getDebugMode();

  if (!email || !password) {
    showToast("error", "Email and password are required.");
    return;
  }

  const result = await request("/auth/login", { email, password, baseURL });

  if (result.ok) {
    await updatePluginConfig({
      email,
      password,
      baseURL,
      skipDevices,
      debugMode,
      encryptedToken: result.encryptedToken,
    });
    showToast("success", result.message || "Login successful.");
    state.hasEncryptedToken = true;
    state.hasPassword = true;
    setLoggedInState(true, true);
    return;
  }

  if (result.twoFactorRequired) {
    setTwoFactorVisible(true);
    showToast(
      "warning",
      result.message || "Two-factor authentication required."
    );
    elements.code.focus();
    return;
  }

  showToast("error", result.message || "Login failed.");
}

async function sendTwoFactorEmail() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const result = await request("/auth/send-2fa-email", { email, baseURL });
  if (result.ok) {
    showToast("success", result.message || "Verification email sent.");
  } else {
    showToast("error", result.message || "Failed to send verification email.");
  }
}

async function verifyTwoFactorCode() {
  const email = getEmail();
  const code = getCode();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const debugMode = getDebugMode();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }
  if (!code) {
    showToast("error", "Verification code is required.");
    return;
  }

  const result = await request("/auth/verify-2fa-code", {
    email,
    code,
    baseURL,
  });
  if (result.ok) {
    await updatePluginConfig({
      email,
      baseURL,
      skipDevices,
      debugMode,
      encryptedToken: result.encryptedToken,
    });
    showToast("success", result.message || "Verification successful.");
    state.hasEncryptedToken = true;
    setLoggedInState(true, state.hasPassword);
  } else {
    showToast("error", result.message || "Verification failed.");
  }
}

async function logout() {
  const result = await request("/auth/logout");
  if (result.ok) {
    await updatePluginConfig({ encryptedToken: undefined });
    showToast("success", result.message || "Logged out.");
    state.hasEncryptedToken = false;
    setLoggedInState(false, state.hasPassword);
    renderDiagnostics(null);
  } else {
    showToast("error", result.message || "Logout failed.");
  }
}

async function loadDiagnostics() {
  const result = await request("/diagnostics/state", {});
  if (!result.ok) {
    renderDiagnostics(null, result.message || "Failed to load diagnostics.");
    return null;
  }

  renderDiagnostics(result);
  return result;
}

function renderDiagnostics(result, errorMessage) {
  elements.diagnosticsList.innerHTML = "";
  state.lastDiagnostics = result || null;

  if (errorMessage) {
    elements.diagnosticsSummary.textContent = errorMessage;
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  if (!result || !result.hasHomeData) {
    elements.diagnosticsSummary.textContent = "No cached HomeData found yet.";
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  const hasToken = Boolean(result.hasEncryptedToken || state.hasEncryptedToken);
  const tokenSummary = hasToken ? "token saved" : "no saved token";
  elements.diagnosticsSummary.textContent = `${result.deviceCount} device(s), ${tokenSummary}, last snapshot ${formatTimestamp(result.generatedAt)}.`;

  if (!result.devices || result.devices.length === 0) {
    elements.diagnosticsEmpty.classList.remove("hidden");
    return;
  }

  elements.diagnosticsEmpty.classList.add("hidden");

  result.devices.forEach((device) => {
    const card = document.createElement("article");
    card.className = "diagnostic-device";
    const localClass = device.connectionHealth || "warn";
    const onlineText =
      device.online === null ? "unknown" : String(device.online);
    card.innerHTML = `
      <div class="device-header">
        <h3>${escapeHtml(device.name || "Unknown device")}</h3>
        <span class="pill ${localClass}">${escapeHtml(device.connectionStatus || device.localConnectivityState || "Unknown")}</span>
      </div>
      <p class="connection-hint">${escapeHtml(device.connectionHint || "No additional transport details are available yet.")}</p>
      <dl>
        <div><dt>DUID</dt><dd>${escapeHtml(device.duid || "unknown")}</dd></div>
        <div><dt>Serial Number</dt><dd>${escapeHtml(device.serialNumber || "n/a")}</dd></div>
        <div><dt>Resolved Model</dt><dd>${escapeHtml(device.resolvedModel || "unknown")}</dd></div>
        <div><dt>Device Model</dt><dd>${escapeHtml(device.deviceModel || "n/a")}</dd></div>
        <div><dt>Product Model</dt><dd>${escapeHtml(device.productModel || "n/a")}</dd></div>
        <div><dt>Product ID</dt><dd>${escapeHtml(device.productId == null ? "n/a" : String(device.productId))}</dd></div>
        <div><dt>HomeData Source</dt><dd>${escapeHtml(device.homeDataSource || "unknown")}</dd></div>
        <div><dt>Online</dt><dd>${escapeHtml(onlineText)}</dd></div>
        <div><dt>Local IP</dt><dd>${escapeHtml(device.localIp || "n/a")}</dd></div>
        <div><dt>Discovery</dt><dd>${escapeHtml(device.localDiscoveryState || "n/a")}</dd></div>
        <div><dt>TCP State</dt><dd>${escapeHtml(device.tcpConnectionState || "n/a")}</dd></div>
        <div><dt>Marked Remote</dt><dd>${escapeHtml(device.isRemote === null ? "unknown" : String(device.isRemote))}</dd></div>
        <div><dt>Remote Reason</dt><dd>${escapeHtml(device.remoteReason || "n/a")}</dd></div>
        <div><dt>Last Transport</dt><dd>${escapeHtml(device.lastTransport || "n/a")}</dd></div>
        <div><dt>Last Reason</dt><dd>${escapeHtml(device.lastTransportReason || "n/a")}</dd></div>
        <div><dt>Last Method</dt><dd>${escapeHtml(device.lastCommandMethod || "n/a")}</dd></div>
      </dl>
    `;
    elements.diagnosticsList.appendChild(card);
  });
}

async function copyDiagnosticsReport() {
  let diagnostics = state.lastDiagnostics;
  if (!diagnostics) {
    diagnostics = await loadDiagnostics();
  }

  if (!diagnostics || !diagnostics.hasHomeData) {
    showToast("warning", "No diagnostics are available to copy yet.");
    return;
  }

  await writeClipboard(buildDiagnosticsReport(diagnostics));
  showToast("success", "Redacted diagnostic report copied.");
}

function buildDiagnosticsReport(result) {
  const hasToken = Boolean(result.hasEncryptedToken || state.hasEncryptedToken);
  const lines = [
    "homebridge-roborock-vacuum2 diagnostic report",
    `generatedAt: ${result.generatedAt || "unknown"}`,
    `pluginVersion: ${result.pluginVersion || "unknown"}`,
    `nodeVersion: ${result.nodeVersion || "unknown"}`,
    `token: ${hasToken ? "present" : "missing"}`,
    `homeData: ${result.hasHomeData ? "present" : "missing"}`,
    `deviceCount: ${result.deviceCount ?? "unknown"}`,
    "",
  ];

  (result.devices || []).forEach((device, index) => {
    lines.push(`device ${index + 1}: ${device.name || "Unknown device"}`);
    lines.push(`  duid: ${maskIdentifier(device.duid)}`);
    lines.push(`  serialNumber: ${maskIdentifier(device.serialNumber)}`);
    lines.push(`  resolvedModel: ${device.resolvedModel || "unknown"}`);
    lines.push(`  productId: ${device.productId || "n/a"}`);
    lines.push(
      `  online: ${device.online === null ? "unknown" : String(device.online)}`
    );
    lines.push(`  connectionStatus: ${device.connectionStatus || "unknown"}`);
    lines.push(`  connectionHint: ${device.connectionHint || "n/a"}`);
    lines.push(`  localIp: ${maskLocalIp(device.localIp)}`);
    lines.push(`  discovery: ${device.localDiscoveryState || "n/a"}`);
    lines.push(`  tcpState: ${device.tcpConnectionState || "n/a"}`);
    lines.push(
      `  markedRemote: ${device.isRemote === null ? "unknown" : String(device.isRemote)}`
    );
    lines.push(`  remoteReason: ${device.remoteReason || "n/a"}`);
    lines.push(`  lastTransport: ${device.lastTransport || "n/a"}`);
    lines.push(`  lastReason: ${device.lastTransportReason || "n/a"}`);
    lines.push(`  lastMethod: ${device.lastCommandMethod || "n/a"}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

async function writeClipboard(text) {
  if (
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the textarea copy path below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function maskIdentifier(value) {
  if (!value) {
    return "n/a";
  }

  const normalized = String(value);
  if (normalized.length <= 8) {
    return "[redacted]";
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function maskLocalIp(value) {
  if (!value) {
    return "n/a";
  }

  const normalized = String(value);
  const ipv4Parts = normalized.split(".");
  if (ipv4Parts.length === 4) {
    return `${ipv4Parts.slice(0, 3).join(".")}.x`;
  }

  return "present (redacted)";
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "https://usiot.roborock.com";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `https://${value.replace(/\/+$/, "")}`;
}

function updateAuthStatus(hasToken, hasPassword = false) {
  elements.authStatus.classList.remove("good", "warn");
  if (hasToken) {
    elements.authStatus.textContent = "Token saved";
    elements.authStatus.classList.add("good");
    return;
  }

  if (hasPassword) {
    elements.authStatus.textContent = "Password fallback";
    elements.authStatus.classList.add("warn");
    return;
  }

  elements.authStatus.textContent = "Login needed";
  elements.authStatus.classList.add("warn");
}

function setTwoFactorVisible(isVisible) {
  elements.twoFactorSection.classList.toggle("hidden", !isVisible);
}

function setLoggedInState(isLoggedIn, hasPassword = false) {
  elements.logout.classList.toggle("hidden", !isLoggedIn);
  elements.login.classList.toggle("hidden", isLoggedIn);
  elements.passwordRow.classList.toggle("hidden", isLoggedIn);
  setTwoFactorVisible(false);
  elements.email.readOnly = isLoggedIn;
  elements.email.parentElement.classList.toggle("readonly", isLoggedIn);
  elements.baseUrl.disabled = isLoggedIn;
  elements.baseUrl.parentElement.classList.toggle("readonly", isLoggedIn);
  updateAuthStatus(isLoggedIn, hasPassword);
}

async function updatePluginConfig(patch) {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return;
  }

  const configs = await window.homebridge.getPluginConfig();
  let config = configs.find(
    (entry) => entry.platform === "RoborockVacuumPlatform"
  );
  if (!config) {
    config = { platform: "RoborockVacuumPlatform", name: "Roborock Vacuum" };
    configs.push(config);
  }

  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  });

  await window.homebridge.updatePluginConfig(configs);
  await window.homebridge.savePluginConfig();
}

function init() {
  loadConfig().catch(() => {
    showToast("error", "Failed to load current config.");
  });
  elements.saveSettings.addEventListener("click", () => saveCredentials(true));
  elements.login.addEventListener("click", login);
  elements.send2fa.addEventListener("click", sendTwoFactorEmail);
  elements.verify2fa.addEventListener("click", verifyTwoFactorCode);
  elements.logout.addEventListener("click", logout);
  elements.copyDiagnostics.addEventListener("click", () => {
    copyDiagnosticsReport().catch(() => {
      showToast("error", "Failed to copy diagnostics.");
    });
  });
  elements.baseUrl.addEventListener("change", () => saveCredentials(false));
  elements.skipDevices.addEventListener("change", () => saveCredentials(false));
  elements.debugMode.addEventListener("change", () => saveCredentials(false));
  elements.email.addEventListener("change", () => saveCredentials(false));
  elements.refreshDiagnostics.addEventListener("click", () => {
    loadDiagnostics().catch(() => {
      showToast("error", "Failed to load diagnostics.");
    });
  });
}

if (window.homebridge) {
  window.homebridge.addEventListener("ready", () => {
    init();
  });
} else {
  document.addEventListener("DOMContentLoaded", init);
}
