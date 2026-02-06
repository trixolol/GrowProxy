"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  server: {
    port: 16999,
    address: "www.growtopia1.com"
  },
  client: {
    gameVersion: "5.42",
    protocol: 225,
    dnsServer: "cloudflare",
    localPort: 0
  },
  log: {
    level: "info",
    printMessage: true,
    printGameUpdatePacket: false,
    printVariant: true,
    printExtra: true
  },
  command: {
    prefix: "/"
  },
  web: {
    port: 443,
    certPath: "resources/cert.pem",
    keyPath: "resources/key.pem",
    ignoreMaintenance: true
  },
  scripts: {
    enabled: true,
    path: "scripts"
  }
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base)) {
    return override;
  }

  const out = { ...base };
  if (!isObject(override)) {
    return out;
  }

  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

function ensureConfigFile(configPath) {
  if (fs.existsSync(configPath)) {
    return;
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

function normalizeConfig(raw) {
  const merged = deepMerge(DEFAULT_CONFIG, raw);
  if (typeof merged.command.prefix !== "string" || merged.command.prefix.length !== 1) {
    merged.command.prefix = DEFAULT_CONFIG.command.prefix;
  }

  const serverPort = Number(merged.server.port);
  merged.server.port = Number.isInteger(serverPort) && serverPort > 0 && serverPort <= 65535
    ? serverPort
    : DEFAULT_CONFIG.server.port;

  const clientLocalPort = Number(merged.client.localPort);
  merged.client.localPort = Number.isInteger(clientLocalPort) && clientLocalPort >= 0 && clientLocalPort <= 65535
    ? clientLocalPort
    : DEFAULT_CONFIG.client.localPort;

  const webPort = Number(merged.web.port);
  merged.web.port = Number.isInteger(webPort) && webPort > 0 && webPort <= 65535
    ? webPort
    : DEFAULT_CONFIG.web.port;

  return merged;
}

function loadConfig(configPath = "config.json") {
  const resolved = path.resolve(configPath);
  ensureConfigFile(resolved);

  const rawText = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(rawText);
  const config = normalizeConfig(parsed);

  return {
    path: resolved,
    config
  };
}

module.exports = {
  loadConfig,
  DEFAULT_CONFIG
};
