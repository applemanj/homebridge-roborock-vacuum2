const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  collectPluginBridgeUsernames,
  findMatterNodeCandidates,
  filterPluginOwnedMatterNodes,
  isPluginOwnedMatterNode,
  normalizeMatterNodeId,
  readHomebridgeConfig,
} = require("../src/ui/matter_pairing");

const PLUGIN_NAME = "homebridge-roborock-vacuum";
const PLATFORM_NAME = "RoborockVacuumPlatform";

const ROBOROCK_BRIDGE_USERNAME = "0E:EA:03:F2:B2:3A";
const ROBOROCK_BRIDGE_NODE_ID = "0EEA03F2B23A";
const VACUUM_NODE_ID = "8CCDBC9225C2";
const ECOWITT_NODE_ID = "0E081BA84CBE";
const SLOWFADE_NODE_ID = "0E7E955ACA94";

let storageRoot;
let matterPath;

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-matter-ui-"));
  matterPath = path.join(storageRoot, "matter");
  fs.mkdirSync(matterPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createNode(nodeId, { commissioned = true } = {}) {
  const nodeDir = path.join(matterPath, nodeId);
  writeJson(path.join(nodeDir, "commissioning.json"), {
    serialNumber: nodeId,
    manualPairingCode: nodeId.endsWith("3A") ? "68081712345" : "34970123456",
    qrCode: "MT:Y8.K9041710100000000",
    passcode: 38070324,
    discriminator: 4083,
    commissioned,
    fabricCount: 1,
  });
  return nodeDir;
}

function createRoborockConfig() {
  writeJson(path.join(storageRoot, "config.json"), {
    bridge: { username: "CC:22:33:44:55:66" },
    platforms: [
      { platform: "config", port: 1234 },
      {
        platform: PLATFORM_NAME,
        email: "user@example.com",
        _bridge: { username: ROBOROCK_BRIDGE_USERNAME },
      },
      {
        platform: "Ecowitt",
        _bridge: { username: "0E:08:1B:A8:4C:BE" },
      },
    ],
  });
}

describe("normalizeMatterNodeId", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeMatterNodeId("0e:ea-03.f2 b2:3a")).toBe("0EEA03F2B23A");
  });
});

describe("collectPluginBridgeUsernames", () => {
  it("collects only Roborock child bridge usernames from config.json", () => {
    createRoborockConfig();
    const config = readHomebridgeConfig(storageRoot);

    const usernames = collectPluginBridgeUsernames(config);

    expect([...usernames]).toEqual([
      normalizeMatterNodeId(ROBOROCK_BRIDGE_USERNAME),
    ]);
  });

  it("returns an empty set when config.json is missing", () => {
    expect(
      collectPluginBridgeUsernames(readHomebridgeConfig(storageRoot))
    ).toEqual(new Set());
  });

  it("returns an empty set when platforms is not an array", () => {
    writeJson(path.join(storageRoot, "config.json"), { platforms: "nope" });

    expect(collectPluginBridgeUsernames({ platforms: "nope" })).toEqual(
      new Set()
    );
  });
});

describe("findMatterNodeCandidates", () => {
  it("lists node directories with readable commissioning data", () => {
    createNode(ROBOROCK_BRIDGE_NODE_ID);
    createNode(VACUUM_NODE_ID);

    const nodes = findMatterNodeCandidates([matterPath]);

    expect(nodes.map((node) => node.id).sort()).toEqual(
      [ROBOROCK_BRIDGE_NODE_ID, VACUUM_NODE_ID].sort()
    );
  });

  it("skips dotted directory names and nodes without commissioning data", () => {
    createNode(ROBOROCK_BRIDGE_NODE_ID);
    fs.mkdirSync(path.join(matterPath, "backup.codex-20240610"));
    writeJson(
      path.join(matterPath, "backup.codex-20240610", "commissioning.json"),
      { serialNumber: "stale" }
    );
    fs.mkdirSync(path.join(matterPath, ECOWITT_NODE_ID));

    const nodes = findMatterNodeCandidates([matterPath]);

    expect(nodes.map((node) => node.id)).toEqual([ROBOROCK_BRIDGE_NODE_ID]);
  });

  it("ignores missing matter directories", () => {
    expect(findMatterNodeCandidates([path.join(storageRoot, "nope")])).toEqual(
      []
    );
  });
});

describe("isPluginOwnedMatterNode", () => {
  it("claims nodes matching a configured Roborock bridge username", () => {
    const nodeDir = createNode(ROBOROCK_BRIDGE_NODE_ID);

    expect(
      isPluginOwnedMatterNode(
        {
          id: ROBOROCK_BRIDGE_NODE_ID,
          dirPath: nodeDir,
          commissioning: {},
        },
        new Set([normalizeMatterNodeId(ROBOROCK_BRIDGE_USERNAME)])
      )
    ).toBe(true);
  });

  it("claims vacuum nodes via homebridge-owner.json", () => {
    const nodeDir = createNode(VACUUM_NODE_ID);
    writeJson(path.join(nodeDir, "homebridge-owner.json"), {
      bridge: ROBOROCK_BRIDGE_USERNAME,
      uuid: "9b97f2b1-fea7-41e1-a5c0-97dbfb6f9599",
      plugin: PLUGIN_NAME,
      platform: PLATFORM_NAME,
    });

    expect(
      isPluginOwnedMatterNode(
        { id: VACUUM_NODE_ID, dirPath: nodeDir, commissioning: {} },
        new Set()
      )
    ).toBe(true);
  });

  it("claims vacuum nodes via accessories.json", () => {
    const nodeDir = createNode(VACUUM_NODE_ID);
    writeJson(path.join(nodeDir, "accessories.json"), [
      {
        plugin: PLUGIN_NAME,
        platform: PLATFORM_NAME,
        uuid: "9b97f2b1-fea7-41e1-a5c0-97dbfb6f9599",
        displayName: "Roborock S6 Pure",
        serialNumber: "2ILAxEZZljqPb6PR4neqMx",
        model: "roborock.vacuum.a08",
      },
    ]);

    expect(
      isPluginOwnedMatterNode(
        { id: VACUUM_NODE_ID, dirPath: nodeDir, commissioning: {} },
        new Set()
      )
    ).toBe(true);
  });

  it("rejects nodes owned by other plugins", () => {
    const nodeDir = createNode(ECOWITT_NODE_ID);
    writeJson(path.join(nodeDir, "accessories.json"), [
      { plugin: "homebridge-ecowitt", platform: "Ecowitt" },
    ]);
    writeJson(path.join(nodeDir, "homebridge-owner.json"), {
      bridge: "0E:08:1B:A8:4C:BE",
      plugin: "homebridge-ecowitt",
      platform: "Ecowitt",
    });

    expect(
      isPluginOwnedMatterNode(
        { id: ECOWITT_NODE_ID, dirPath: nodeDir, commissioning: {} },
        new Set([normalizeMatterNodeId(ROBOROCK_BRIDGE_USERNAME)])
      )
    ).toBe(false);
  });

  it("rejects unknown nodes without owner metadata when config is missing", () => {
    const nodeDir = createNode(SLOWFADE_NODE_ID);

    expect(
      isPluginOwnedMatterNode(
        { id: SLOWFADE_NODE_ID, dirPath: nodeDir, commissioning: {} },
        new Set()
      )
    ).toBe(false);
  });

  it("ignores malformed owner and accessories JSON", () => {
    const nodeDir = createNode(VACUUM_NODE_ID);
    fs.writeFileSync(path.join(nodeDir, "homebridge-owner.json"), "{not json");
    fs.writeFileSync(path.join(nodeDir, "accessories.json"), "[not json");

    expect(
      isPluginOwnedMatterNode(
        { id: VACUUM_NODE_ID, dirPath: nodeDir, commissioning: {} },
        new Set()
      )
    ).toBe(false);
  });
});

describe("filterPluginOwnedMatterNodes", () => {
  it("keeps the plugin's bridge and vacuum nodes, drops other plugins", () => {
    createRoborockConfig();
    const bridgeDir = createNode(ROBOROCK_BRIDGE_NODE_ID);
    const vacuumDir = createNode(VACUUM_NODE_ID);
    writeJson(path.join(vacuumDir, "homebridge-owner.json"), {
      bridge: ROBOROCK_BRIDGE_USERNAME,
      plugin: PLUGIN_NAME,
      platform: PLATFORM_NAME,
    });
    const ecowittDir = createNode(ECOWITT_NODE_ID);
    writeJson(path.join(ecowittDir, "accessories.json"), [
      { plugin: "homebridge-ecowitt", platform: "Ecowitt" },
    ]);

    const config = readHomebridgeConfig(storageRoot);
    const usernames = collectPluginBridgeUsernames(config);
    const nodes = findMatterNodeCandidates([matterPath]);
    const owned = filterPluginOwnedMatterNodes(nodes, usernames);

    expect(owned.map((node) => node.id).sort()).toEqual(
      [ROBOROCK_BRIDGE_NODE_ID, VACUUM_NODE_ID].sort()
    );
  });

  it("drops every node when config.json is missing and no node carries owner metadata", () => {
    createNode(ROBOROCK_BRIDGE_NODE_ID);
    createNode(ECOWITT_NODE_ID);

    const nodes = findMatterNodeCandidates([matterPath]);
    const owned = filterPluginOwnedMatterNodes(nodes, new Set());

    expect(owned).toEqual([]);
  });
});
