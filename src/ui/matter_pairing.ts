import fs from "fs";
import path from "path";

import { PLATFORM_NAME, PLUGIN_NAME } from "../settings";

/**
 * Matter pairing codes live in a shared Homebridge storage directory
 * (`matter/<node id>/commissioning.json`) that every Homebridge 2 plugin with
 * Matter support reads from. Returning the pairing code of a bridge that
 * belongs to a different plugin would advertise that plugin's Matter node as
 * if it were a Roborock vacuum. Only nodes owned by this plugin are shown.
 */

export interface MatterNodeCandidate {
  /** Directory name such as `0EEA03F2B23A`. */
  id: string;
  /** Absolute path of the node directory. */
  dirPath: string;
  /** Raw commissioning.json content, already parsed. */
  commissioning: Record<string, any>;
}

/**
 * Collects the child bridge usernames (`_bridge.username`) configured for this
 * plugin in a Homebridge `config.json`. Node ids are bridge usernames with the
 * colons stripped, so these identify our own Matter bridge nodes.
 */
export function collectPluginBridgeUsernames(
  homebridgeConfig: Record<string, any> | null
): Set<string> {
  const usernames = new Set<string>();
  if (!homebridgeConfig || !Array.isArray(homebridgeConfig.platforms)) {
    return usernames;
  }

  for (const platform of homebridgeConfig.platforms) {
    if (
      !platform ||
      typeof platform !== "object" ||
      platform.platform !== PLATFORM_NAME
    ) {
      continue;
    }

    const username = platform._bridge?.username;
    if (typeof username === "string" && username.trim()) {
      usernames.add(normalizeMatterNodeId(username));
    }
  }

  return usernames;
}

/** Compares node ids case-insensitively with all separators removed. */
export function normalizeMatterNodeId(value: string): string {
  return value.replace(/[\s:.-]/g, "").toUpperCase();
}

function readJsonFile(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Determines whether a Matter node directory belongs to this plugin.
 *
 * A node is ours when any of the following hold:
 *  - `homebridge-owner.json` inside the node directory names this plugin.
 *    Homebridge writes this file for external accessories (such as the RVC
 *    vacuum), so it identifies our vacuum nodes.
 *  - `accessories.json` inside the node directory lists at least one
 *    accessory published by this plugin.
 *  - The node id equals a child bridge username configured for this plugin,
 *    which identifies our own Matter bridge node.
 */
export function isPluginOwnedMatterNode(
  node: MatterNodeCandidate,
  pluginBridgeUsernames: Set<string>
): boolean {
  if (pluginBridgeUsernames.has(normalizeMatterNodeId(node.id))) {
    return true;
  }

  const owner = readJsonFile(path.join(node.dirPath, "homebridge-owner.json"));
  if (owner?.plugin === PLUGIN_NAME || owner?.platform === PLATFORM_NAME) {
    return true;
  }

  const accessories = readJsonFile(path.join(node.dirPath, "accessories.json"));
  if (Array.isArray(accessories)) {
    for (const accessory of accessories) {
      if (!accessory || typeof accessory !== "object") {
        continue;
      }

      if (accessory.plugin === PLUGIN_NAME) {
        return true;
      }
      if (accessory.platform === PLATFORM_NAME) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Reads the Homebridge `config.json` that created this plugin's storage and
 * returns the child bridge usernames assigned to this plugin's platforms.
 */
export function readHomebridgeConfig(
  storagePath: string
): Record<string, any> | null {
  return readJsonFile(path.join(storagePath, "config.json"));
}

/**
 * Loads the commissioning payload for a Matter node directory, or null when the
 * node has no readable commissioning data.
 */
export function readCommissioning(
  nodeDirPath: string
): Record<string, any> | null {
  return readJsonFile(path.join(nodeDirPath, "commissioning.json"));
}

/**
 * Lists the Matter node directories that carry readable commissioning data.
 * Directories whose name contains a dot are skipped: Homebridge backups and
 * this plugin's own snapshots use dotted names and must not be paired.
 */
export function findMatterNodeCandidates(
  matterPaths: string[]
): MatterNodeCandidate[] {
  const nodes: MatterNodeCandidate[] = [];
  const seen = new Set<string>();

  for (const matterPath of matterPaths) {
    if (!fs.existsSync(matterPath)) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(matterPath, { withFileTypes: true });
    } catch {
      // Ignore unreadable Matter storage locations and continue searching.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.includes(".")) {
        continue;
      }

      const dirPath = path.join(matterPath, entry.name);
      const commissioning = readCommissioning(dirPath);
      if (!commissioning) {
        continue;
      }

      const key = realPath(dirPath);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      nodes.push({ id: entry.name, dirPath, commissioning });
    }
  }

  return nodes;
}

/**
 * Filters Matter node candidates down to the nodes owned by this plugin.
 */
export function filterPluginOwnedMatterNodes(
  nodes: MatterNodeCandidate[],
  pluginBridgeUsernames: Set<string>
): MatterNodeCandidate[] {
  return nodes.filter((node) =>
    isPluginOwnedMatterNode(node, pluginBridgeUsernames)
  );
}

function realPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
