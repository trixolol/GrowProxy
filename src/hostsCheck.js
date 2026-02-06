"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INTERCEPT_HOSTS = [
  "growtopia1.com",
  "www.growtopia1.com",
  "growtopia2.com",
  "www.growtopia2.com"
];

function getHostsPath() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\drivers\\etc\\hosts";
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    return "/etc/hosts";
  }

  return path.join(os.homedir(), "hosts");
}

function parseHosts(text) {
  const map = new Map();
  const lines = String(text || "").split(/\r?\n/g);

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const noComment = line.split("#", 1)[0].trim();
    if (!noComment) {
      continue;
    }

    const tokens = noComment.split(/\s+/g).filter(Boolean);
    if (tokens.length < 2) {
      continue;
    }

    const ip = tokens[0];
    const hosts = tokens.slice(1);

    for (const host of hosts) {
      map.set(host.toLowerCase(), ip);
    }
  }

  return map;
}

function checkGrowtopiaHostMappings(logger = console, config = null) {
  const hostsPath = getHostsPath();
  if (!fs.existsSync(hostsPath)) {
    return;
  }

  const content = fs.readFileSync(hostsPath, "utf8");
  const map = parseHosts(content);

  let foundBad = false;
  for (const domain of INTERCEPT_HOSTS) {
    const value = map.get(domain);
    if (!value) {
      foundBad = true;
      logger.warn(
        `Hosts mapping missing for ${domain}. Set it to 127.0.0.1 for GrowProxy interception.`
      );
      continue;
    }

    if (value === "0.0.0.0") {
      foundBad = true;
      logger.error(
        `Hosts mapping blocks ${domain} via 0.0.0.0. Use 127.0.0.1 for GrowProxy interception.`
      );
      continue;
    }

    if (value !== "127.0.0.1" && value !== "::1") {
      foundBad = true;
      logger.warn(
        `Hosts mapping for ${domain} is ${value}. Expected 127.0.0.1 (or ::1) for local interception.`
      );
    }
  }

  if (!foundBad) {
    return;
  }

  logger.warn("Suggested hosts entries:");
  for (const domain of INTERCEPT_HOSTS) {
    logger.warn(`127.0.0.1 ${domain}`);
  }
}

module.exports = {
  checkGrowtopiaHostMappings
};
