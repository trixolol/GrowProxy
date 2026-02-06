"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { URL } = require("node:url");
const { EventEmitter } = require("node:events");
const { Client, Peer } = require("growtopia.js");

const { DnsResolver } = require("./dnsResolver");
const { TextParse } = require("./textParse");
const { ensureTlsCertificate } = require("./tls");
const { WorldState } = require("./worldState");
const { TaskScheduler } = require("./taskScheduler");
const { CommandRegistry } = require("./commandRegistry");
const { registerBuiltinCommands } = require("./builtinCommands");
const { ScriptManager } = require("./scriptManager");
const {
  NET_MESSAGE,
  GAME_PACKET,
  PacketId,
  parsePacket,
  parseOnSendToServer,
  parseOnSpawn,
  parseOnRemove,
  rewriteOnSendToServerExtra,
  encodeVariantArgs,
  buildTextPacket,
  buildTankPacket,
  ensureNullTerminator,
  toHex
} = require("./packet");

function isInRangePort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function normalizeServerDataBody(rawBody) {
  let normalized = String(rawBody || "");

  // Growtopia currently mixes "\n", "\r\n", and occasionally "\rtype|1" inline.
  // Normalize those so key parsing stays stable across formats.
  normalized = normalized.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/\rtype\|/g, "\ntype|");
  normalized = normalized.replace(/\rbeta_type\|/g, "\nbeta_type|");
  normalized = normalized.replace(/\rmeta\|/g, "\nmeta|");

  return normalized;
}

function extractServerDataPassthroughLines(rawBody) {
  const lines = String(rawBody || "").replace(/\r\n/g, "\n").split("\n");
  const passthrough = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      continue;
    }

    // Keep marker-style lines (for example "RTENDMARKERBS1001") that are not key/value entries.
    if (!line.includes("|")) {
      passthrough.push(line);
    }
  }

  return passthrough;
}

const DEFAULT_UPSTREAM_HOSTS = [
  "www.growtopia1.com",
  "growtopia1.com"
];

function buildUpstreamHostCandidates(...primaryHosts) {
  const seen = new Set();
  const out = [];
  const values = [...primaryHosts, ...DEFAULT_UPSTREAM_HOSTS];

  for (const value of values) {
    const host = String(value || "").trim().toLowerCase();
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    out.push(host);
  }

  return out;
}

function getHostWithoutPort(hostHeaderValue) {
  const raw = String(hostHeaderValue || "").trim();
  if (!raw) {
    return "";
  }

  const withoutIpv6Brackets = raw.startsWith("[") ? raw.slice(1) : raw;
  const closingBracketIndex = withoutIpv6Brackets.indexOf("]");
  if (closingBracketIndex >= 0) {
    return withoutIpv6Brackets.slice(0, closingBracketIndex).toLowerCase();
  }

  const portSplitIndex = withoutIpv6Brackets.lastIndexOf(":");
  if (portSplitIndex <= 0) {
    return withoutIpv6Brackets.toLowerCase();
  }

  const maybePort = withoutIpv6Brackets.slice(portSplitIndex + 1);
  if (/^\d+$/.test(maybePort)) {
    return withoutIpv6Brackets.slice(0, portSplitIndex).toLowerCase();
  }

  return withoutIpv6Brackets.toLowerCase();
}

function normalizeRequestPath(route) {
  const value = String(route || "/");
  if (value.startsWith("/")) {
    return value;
  }

  try {
    const parsed = new URL(value);
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return `/${value}`;
  }
}

function shouldReadRequestBody(method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
}

function extractInputTextFallback(rawText) {
  const source = String(rawText || "");
  if (!source) {
    return "";
  }

  // Accept both "text|..." and "|text|..." line styles.
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("text|")) {
      return trimmed.slice("text|".length);
    }

    if (trimmed.startsWith("|text|")) {
      return trimmed.slice("|text|".length);
    }
  }

  return "";
}

function hasPendingEndpoint(address, port) {
  return Boolean(String(address || "").trim()) && isInRangePort(Number(port));
}

class ProxyCore extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.running = false;

    this.pendingAddress = "";
    this.pendingPort = 65535;

    this.world = new WorldState();
    this.scheduler = new TaskScheduler();
    this.commandRegistry = new CommandRegistry(this.config.command.prefix);
    this.scriptEvents = new EventEmitter();
    this.scriptManager = new ScriptManager(this.config.scripts, logger);

    this.clientPeer = null;
    this.serverPeer = null;
    this.webServer = null;
    this.proxyClientListening = false;
    this.upstreamRetryTimer = null;
    this.upstreamRetryCount = 0;

    this.dnsResolver = new DnsResolver(this.config.client.dnsServer, logger);

    this.proxyServer = new Client({
      enet: {
        ip: "0.0.0.0",
        port: this.config.server.port,
        maxPeers: 1,
        useNewPacket: { asClient: false },
        useNewServerPacket: true,
        channelLimit: 2
      }
    });

    this.proxyClient = new Client({
      enet: {
        ip: "0.0.0.0",
        port: this.config.client.localPort,
        maxPeers: 4,
        // Growtopia upstream expects the "new packet" mode on client hosts.
        useNewPacket: { asClient: true },
        useNewServerPacket: false,
        channelLimit: 2
      }
    });

    registerBuiltinCommands(this.commandRegistry, this, this.logger);
    this.setupNetworkHandlers();
    this.setupScriptHooks();
  }

  setupScriptHooks() {
    this.scriptManager.load({
      on: (eventName, callback) => this.scriptEvents.on(eventName, callback),
      registerCommand: (name, description, handler) => this.commandRegistry.register(name, description, handler),
      logger: this.logger,
      config: this.config
    });
  }

  setupNetworkHandlers() {
    this.proxyServer.on("ready", () => {
      this.logger.info(`Proxy server listening on 0.0.0.0:${this.config.server.port}`);
    });

    this.proxyServer.on("connect", (netId) => {
      this.logger.info(`Client connected to proxy server (netId=${netId})`);
      this.clientPeer = new Peer(this.proxyServer, netId);

      if (isInRangePort(this.pendingPort) && this.pendingAddress) {
        this.connectPendingServer();
      } else {
        this.logger.warn("No pending upstream endpoint yet. Waiting for server_data.php.");
      }
    });

    this.proxyServer.on("raw", (netId, channelId, data) => {
      if (!this.clientPeer || this.clientPeer.data.netID !== netId) {
        return;
      }

      this.handleServerBoundPacket(channelId, Buffer.from(data));
    });

    this.proxyServer.on("disconnect", (netId) => {
      this.logger.info(`Client disconnected from proxy server (netId=${netId})`);
      if (this.clientPeer && this.clientPeer.data.netID === netId) {
        this.clientPeer = null;
      }

      this.clearUpstreamRetry();
      if (!hasPendingEndpoint(this.pendingAddress, this.pendingPort)) {
        this.pendingAddress = "";
        this.pendingPort = 65535;
      } else {
        this.logger.info(
          `Preserving pending upstream target across client disconnect: ${this.pendingAddress}:${this.pendingPort}`
        );
      }
      this.world.clear();

      if (this.serverPeer) {
        this.serverPeer.disconnect("later");
      }
    });

    this.proxyServer.on("error", (error) => {
      this.logger.error(`Proxy server error: ${error.message}`);
    });

    this.proxyClient.on("ready", () => {
      this.logger.info("Proxy client ready");
    });

    this.proxyClient.on("connect", (netId) => {
      this.logger.info(`Connected to Growtopia server (netId=${netId})`);
      this.clearUpstreamRetry();
      this.serverPeer = new Peer(this.proxyClient, netId);
    });

    this.proxyClient.on("raw", (netId, channelId, data) => {
      if (!this.serverPeer || this.serverPeer.data.netID !== netId) {
        return;
      }

      this.handleClientBoundPacket(channelId, Buffer.from(data));
    });

    this.proxyClient.on("disconnect", (netId) => {
      this.logger.info(`Disconnected from Growtopia server (netId=${netId})`);
      if (this.serverPeer && this.serverPeer.data.netID === netId) {
        this.serverPeer = null;
      }

      if (this.clientPeer && hasPendingEndpoint(this.pendingAddress, this.pendingPort)) {
        this.logger.info(
          `Upstream disconnected during handoff. Reconnecting to pending target ${this.pendingAddress}:${this.pendingPort}`
        );
        this.connectPendingServer();
        return;
      }

      if (this.clientPeer) {
        this.clientPeer.disconnect("later");
      }
    });

    this.proxyClient.on("error", (error) => {
      this.logger.error(`Proxy client error: ${error.message}`);
    });
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.startWebServer();
    this.proxyServer.listen();
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.scheduler.cancelAll();
    this.clearUpstreamRetry();

    if (this.clientPeer) {
      this.clientPeer.disconnect("now");
      this.clientPeer = null;
    }

    if (this.serverPeer) {
      this.serverPeer.disconnect("now");
      this.serverPeer = null;
    }

    if (this.webServer) {
      this.webServer.close();
      this.webServer = null;
    }
  }

  isServerConnected() {
    return this.serverPeer !== null;
  }

  getProxyClientPeerLimit() {
    try {
      const hostLimit = Number(this.proxyClient?.host?.peerLimit);
      if (Number.isInteger(hostLimit) && hostLimit > 0) {
        return hostLimit;
      }
    } catch {
      // ignore and fall back
    }

    const cfgLimit = Number(this.proxyClient?.config?.enet?.maxPeers);
    if (Number.isInteger(cfgLimit) && cfgLimit > 0) {
      return cfgLimit;
    }

    return 4;
  }

  getProxyClientPeerCount() {
    try {
      const value = this.proxyClient?.host?.peerCount?.();
      if (typeof value === "number") {
        return value;
      }
    } catch {
      // ignore
    }

    return -1;
  }

  cleanupProxyClientPeers(reason = "manual") {
    if (!this.proxyClient?.host?.getPeer) {
      return 0;
    }

    let resetCount = 0;
    const limit = this.getProxyClientPeerLimit();
    for (let i = 0; i < limit; i += 1) {
      try {
        const nativePeer = this.proxyClient.host.getPeer(i);
        if (!nativePeer) {
          continue;
        }

        const connected = Boolean(nativePeer.connected);
        const state = Number(nativePeer.state);
        if (!connected && state === 0) {
          continue;
        }

        if (typeof nativePeer.reset === "function") {
          nativePeer.reset(this.proxyClient.host);
          resetCount += 1;
          continue;
        }

        if (typeof nativePeer.disconnectNow === "function") {
          nativePeer.disconnectNow(this.proxyClient.host, 0);
          resetCount += 1;
        }
      } catch {
        // getPeer throws for invalid/unallocated slots; ignore
      }
    }

    if (resetCount > 0) {
      this.logger.warn(`Reset ${resetCount} stale upstream peer(s) before connect (${reason}).`);
    }

    return resetCount;
  }

  connectPendingServer() {
    const cleanedAddress = String(this.pendingAddress || "").replace(/\0/g, "").trim();
    const cleanedPort = Number(this.pendingPort);
    if (!cleanedAddress || !isInRangePort(cleanedPort)) {
      return false;
    }
    this.pendingAddress = cleanedAddress;
    this.pendingPort = cleanedPort;

    if (this.serverPeer) {
      this.logger.warn("Upstream peer already exists. Disconnecting stale peer and retrying...");
      try {
        this.serverPeer.disconnect("now");
      } catch {
        // no-op
      }
      this.serverPeer = null;
      this.scheduleUpstreamRetry();
      return false;
    }

    if (!this.proxyClientListening) {
      this.proxyClient.listen();
      this.proxyClientListening = true;
    }

    this.logger.debug(`Connecting upstream -> ${this.pendingAddress}:${this.pendingPort}`);
    let ok = this.proxyClient.connect(this.pendingAddress, this.pendingPort);
    if (!ok) {
      const peerCount = this.getProxyClientPeerCount();
      this.logger.warn(
        `Failed to initiate upstream connection to ${this.pendingAddress}:${this.pendingPort}`
        + (peerCount >= 0 ? ` (peerCount=${peerCount})` : "")
      );

      const resetCount = this.cleanupProxyClientPeers("connect-init-failed");
      if (resetCount > 0) {
        ok = this.proxyClient.connect(this.pendingAddress, this.pendingPort);
      }

      if (!ok) {
        const peerCountAfter = this.getProxyClientPeerCount();
        this.logger.warn(
          `Retry after peer reset still failed for ${this.pendingAddress}:${this.pendingPort}`
          + (peerCountAfter >= 0 ? ` (peerCount=${peerCountAfter})` : "")
        );
        this.scheduleUpstreamRetry();
        return false;
      }
    }

    if (ok) {
      this.logger.info(`Initiated upstream ENet connect to ${this.pendingAddress}:${this.pendingPort}`);
      this.clearUpstreamRetry();
      this.pendingAddress = "";
      this.pendingPort = 65535;
      return true;
    }

    if (!ok) {
      this.scheduleUpstreamRetry();
      return false;
    }
    return false;
  }

  clearUpstreamRetry() {
    if (this.upstreamRetryTimer) {
      clearTimeout(this.upstreamRetryTimer);
      this.upstreamRetryTimer = null;
    }
    this.upstreamRetryCount = 0;
  }

  scheduleUpstreamRetry() {
    if (!this.clientPeer || !this.pendingAddress || !isInRangePort(this.pendingPort)) {
      return;
    }

    if (this.upstreamRetryTimer) {
      return;
    }

    this.upstreamRetryCount += 1;
    if (this.upstreamRetryCount > 12) {
      this.logger.error(
        `Exceeded upstream retry budget for ${this.pendingAddress}:${this.pendingPort}. `
        + "Wait for next OnSendToServer/update."
      );
      return;
    }

    const delayMs = Math.min(3000, 250 * this.upstreamRetryCount);
    this.logger.warn(
      `Retrying upstream connection (${this.upstreamRetryCount}/12) in ${delayMs}ms `
      + `to ${this.pendingAddress}:${this.pendingPort}`
    );
    this.upstreamRetryTimer = setTimeout(() => {
      this.upstreamRetryTimer = null;
      this.connectPendingServer();
    }, delayMs);
  }

  emitScriptEvent(name, context) {
    try {
      this.scriptEvents.emit(name, context);
    } catch (error) {
      this.logger.error(`Script event "${name}" failed: ${error.message}`);
    }
  }

  logDecoded(direction, parsed, raw) {
    if (parsed.kind === "text") {
      if (this.config.log.printMessage) {
        this.logger.info(`[${direction}] ${parsed.packetId}:\n${parsed.text}`);
      }
      return;
    }

    if (parsed.kind === "tank") {
      if (this.config.log.printGameUpdatePacket) {
        this.logger.info(`[${direction}] Tank header: ${toHex(raw.subarray(0, Math.min(60, raw.length)))}`);
      }
      if (this.config.log.printVariant && Array.isArray(parsed.variantArgs)) {
        this.logger.info(`[${direction}] Variant ${parsed.variantFunction}: ${JSON.stringify(parsed.variantArgs)}`);
      }
      if (this.config.log.printExtra && parsed.extra && parsed.extra.length > 1 && !Array.isArray(parsed.variantArgs)) {
        this.logger.debug(`[${direction}] Extra: ${toHex(parsed.extra)}`);
      }
    }
  }

  handleServerBoundPacket(channelId, rawData) {
    const parsed = parsePacket(rawData);
    this.logDecoded("ServerBound", parsed, rawData);

    const context = {
      direction: "ServerBound",
      channelId,
      parsed,
      raw: rawData,
      canceled: false
    };

    if (parsed.packetId === PacketId.JoinRequest) {
      this.world.clear();
    }

    if (parsed.packetId === PacketId.Input) {
      const candidates = new Set();
      const directText = String(parsed.inputText || "");
      if (directText) {
        candidates.add(directText);
      }
      const fallbackText = extractInputTextFallback(parsed.text || "");
      if (fallbackText) {
        candidates.add(fallbackText);
      }

      let executed = false;
      for (const candidate of candidates) {
        if (this.commandRegistry.execute(candidate, { proxy: this, logger: this.logger })) {
          executed = true;
          break;
        }
      }

      if (executed) {
        context.canceled = true;
      } else if (candidates.size > 0) {
        this.logger.debug(`Input command not intercepted. Candidates: ${JSON.stringify([...candidates])}`);
      }
    }

    if (parsed.packetId === PacketId.Quit) {
      context.canceled = true;
      if (this.clientPeer) {
        this.clientPeer.disconnect("normal");
      }
      if (this.serverPeer) {
        this.serverPeer.disconnect("now");
      }
    }

    if (parsed.packetId === PacketId.Disconnect) {
      context.canceled = true;
      if (this.clientPeer) {
        this.clientPeer.disconnect("now");
      }
      if (this.serverPeer) {
        this.serverPeer.disconnect("now");
      }
    }

    this.emitScriptEvent("serverBoundPacket", context);
    if (context.canceled) {
      return;
    }

    if (!this.serverPeer) {
      return;
    }

    this.sendToServer(context.raw, channelId);
  }

  handleClientBoundPacket(channelId, rawData) {
    const hadTrailingNull = rawData.length > 0 && rawData[rawData.length - 1] === 0;
    const parsed = parsePacket(rawData);
    this.logDecoded("ClientBound", parsed, rawData);

    const context = {
      direction: "ClientBound",
      channelId,
      parsed,
      raw: rawData,
      canceled: false
    };

    if (parsed.packetId === PacketId.OnSendToServer && Array.isArray(parsed.variantArgs)) {
      const sendToServer = parseOnSendToServer(parsed.variantArgs);
      if (sendToServer) {
        this.logger.info(`OnSendToServer args length=${parsed.variantArgs.length}, upstream=${sendToServer.address}:${sendToServer.port}`);
        this.pendingAddress = sendToServer.address;
        this.pendingPort = sendToServer.port;

        const modifiedExtra = rewriteOnSendToServerExtra(
          parsed.extra,
          "127.0.0.1",
          this.config.server.port
        );

        if (modifiedExtra) {
          const modifiedTank = buildTankPacket({
            header: parsed.header,
            packetType: GAME_PACKET.CALL_FUNCTION,
            netId: parsed.netId,
            targetNetId: parsed.targetNetId,
            state: parsed.state,
            info: parsed.info,
            extra: modifiedExtra
          });

          context.raw = hadTrailingNull ? ensureNullTerminator(modifiedTank) : modifiedTank;
        } else {
          this.logger.warn("Failed to rewrite OnSendToServer variant payload. Forwarding original payload.");
        }

        if (this.clientPeer && !this.serverPeer) {
          this.logger.info(
            `Attempting immediate upstream connect after OnSendToServer -> ${this.pendingAddress}:${this.pendingPort}`
          );
          this.connectPendingServer();
        } else if (this.serverPeer) {
          this.logger.info(
            "Received OnSendToServer while already connected upstream. "
            + "Keeping pending endpoint for next reconnect."
          );
        }
      } else {
        this.logger.warn("Failed to parse OnSendToServer packet. Forwarding original variant payload.");
      }
    }

    if (parsed.packetId === PacketId.OnSpawn && Array.isArray(parsed.variantArgs)) {
      const spawnData = parseOnSpawn(parsed.variantArgs);
      if (spawnData) {
        this.world.onSpawn(spawnData);
      }
    }

    if (parsed.packetId === PacketId.OnRemove && Array.isArray(parsed.variantArgs)) {
      const removeData = parseOnRemove(parsed.variantArgs);
      if (removeData) {
        this.world.onRemove(removeData.netId);
      }
    }

    this.emitScriptEvent("clientBoundPacket", context);
    if (context.canceled) {
      return;
    }

    if (!this.clientPeer) {
      return;
    }

    this.sendToClient(context.raw, channelId);
  }

  sendToServer(buffer, channelId = 0) {
    if (!this.serverPeer) {
      return false;
    }

    try {
      this.proxyClient.send(this.serverPeer.data.netID, channelId, buffer);
      return true;
    } catch (error) {
      this.logger.error(`Failed sending to server: ${error.message}`);
      return false;
    }
  }

  sendToClient(buffer, channelId = 0) {
    if (!this.clientPeer) {
      return false;
    }

    try {
      this.proxyServer.send(this.clientPeer.data.netID, channelId, buffer);
      return true;
    } catch (error) {
      this.logger.error(`Failed sending to client: ${error.message}`);
      return false;
    }
  }

  sendLog(message) {
    const parser = new TextParse();
    parser.add("action", "log");
    parser.add("msg", String(message));
    return this.sendToClient(buildTextPacket(NET_MESSAGE.GAME_MESSAGE, parser.getRaw()), 0);
  }

  sendQuitToExit() {
    const parser = new TextParse();
    parser.add("action", "quit_to_exit");
    return this.sendToServer(buildTextPacket(NET_MESSAGE.GAME_MESSAGE, parser.getRaw()), 0);
  }

  sendJoinRequest(worldName, invitedWorld = false) {
    const parser = new TextParse();
    parser.add("action", "join_request");
    parser.add("name", String(worldName || ""));
    parser.add("invitedWorld", invitedWorld ? "1" : "0");
    return this.sendToServer(buildTextPacket(NET_MESSAGE.GAME_MESSAGE, parser.getRaw()), 0);
  }

  sendVariantToClient(functionName, args = [], options = {}) {
    try {
      const variantArgs = [String(functionName), ...args];
      const extra = encodeVariantArgs(variantArgs);
      const tank = buildTankPacket({
        packetType: GAME_PACKET.CALL_FUNCTION,
        netId: Number(options.netId ?? -1),
        targetNetId: Number(options.targetNetId ?? 0),
        info: Number(options.delay ?? 0),
        extra
      });
      return this.sendToClient(ensureNullTerminator(tank), Number(options.channelId ?? 0));
    } catch (error) {
      this.logger.error(`Failed to send client variant "${functionName}": ${error.message}`);
      return false;
    }
  }

  async startWebServer() {
    ensureTlsCertificate(this.config.web.certPath, this.config.web.keyPath, this.logger);

    const cert = fs.readFileSync(path.resolve(this.config.web.certPath), "utf8");
    const key = fs.readFileSync(path.resolve(this.config.web.keyPath), "utf8");

    this.webServer = https.createServer({ cert, key }, async (req, res) => {
      try {
        const method = String(req.method || "GET").toUpperCase();
        const route = normalizeRequestPath(req.url);
        const isServerDataRoute = route.startsWith("/growtopia/server_data.php");
        const isServerDataMethod = method === "POST" || method === "GET";

        const bodyBuffer = shouldReadRequestBody(method)
          ? await this.readRequestBody(req)
          : Buffer.alloc(0);

        if (isServerDataRoute && isServerDataMethod) {
          this.logger.info("Headers:");
          for (const [key, value] of Object.entries(req.headers || {})) {
            this.logger.info(`\t${key}: ${value}`);
          }

          const reqUrl = new URL(route, `https://${req.headers.host || "localhost"}`);
          const reqParams = reqUrl.searchParams.toString();
          if (reqParams) {
            this.logger.info("Params:");
            this.logger.info(`\t${reqParams}`);
          }

          if (bodyBuffer.length > 0) {
            this.logger.info("Body:");
            this.logger.info(`\t${bodyBuffer.toString("utf8")}`);
          }

          const proxied = await this.handleServerDataRequest(req, bodyBuffer.toString("utf8"));
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(proxied);
          this.logger.info(`${method} ${route} ${res.statusCode}`);
          return;
        }

        const proxied = await this.handleGenericHttpsRequest(req, bodyBuffer);
        res.statusCode = proxied.statusCode;

        const hopByHopHeaders = new Set([
          "connection",
          "keep-alive",
          "proxy-authenticate",
          "proxy-authorization",
          "te",
          "trailers",
          "transfer-encoding",
          "upgrade"
        ]);

        for (const [headerNameRaw, headerValue] of Object.entries(proxied.headers || {})) {
          const headerName = String(headerNameRaw || "");
          if (!headerName || hopByHopHeaders.has(headerName.toLowerCase())) {
            continue;
          }

          if (typeof headerValue === "undefined") {
            continue;
          }

          res.setHeader(headerName, headerValue);
        }

        res.end(proxied.body);
        this.logger.info(`${method} ${route} ${res.statusCode}`);
      } catch (error) {
        this.logger.error(`HTTPS handler failed for ${req.method || "GET"} ${req.url || "/"}: ${error.message}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain");
        res.end("Internal Server Error");
      }
    });

    await new Promise((resolve) => {
      this.webServer.once("error", (error) => {
        this.logger.error(`HTTPS bind failed on port ${this.config.web.port}: ${error.message}`);
        resolve();
      });

      this.webServer.listen(this.config.web.port, "0.0.0.0", () => {
        this.logger.info(`HTTPS server listening on 0.0.0.0:${this.config.web.port}`);
        resolve();
      });
    });
  }

  readRequestBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handleGenericHttpsRequest(req, bodyBuffer) {
    const requestHost = getHostWithoutPort(req.headers.host);
    const requestPath = normalizeRequestPath(req.url);
    const method = String(req.method || "GET").toUpperCase();
    const configuredHost = String(this.config.server.address || "").trim().toLowerCase();
    const candidateHosts = [];
    const isGrowtopiaAliasHost = requestHost === "growtopia1.com"
      || requestHost === "www.growtopia1.com"
      || requestHost === "growtopia2.com"
      || requestHost === "www.growtopia2.com";

    if (isGrowtopiaAliasHost) {
      if (configuredHost) {
        candidateHosts.push(configuredHost);
      }
      if (requestHost && requestHost !== configuredHost) {
        candidateHosts.push(requestHost);
      }
    } else {
      if (requestHost) {
        candidateHosts.push(requestHost);
      }
      if (configuredHost && configuredHost !== requestHost) {
        candidateHosts.push(configuredHost);
      }
    }

    let lastError = null;
    for (let hostIndex = 0; hostIndex < candidateHosts.length; hostIndex += 1) {
      const targetHost = candidateHosts[hostIndex];
      const resolvedIps = await this.dnsResolver.resolveIPv4All(targetHost);
      if (resolvedIps.length === 0) {
        this.logger.warn(`Failed to resolve upstream host "${targetHost}"`);
        continue;
      }

      for (const resolvedIp of resolvedIps.slice(0, 2)) {
        try {
          const response = await this.proxyGenericToUpstream(
            resolvedIp,
            targetHost,
            requestPath,
            method,
            req.headers,
            bodyBuffer
          );
          lastError = null;
          if (response.statusCode >= 400) {
            this.logger.warn(
              `Upstream HTTPS ${method} ${requestPath} -> ${response.statusCode} via ${targetHost} (${resolvedIp})`
            );

            const canFallbackHost = hostIndex + 1 < candidateHosts.length;
            const retryableStatus = response.statusCode === 403 || response.statusCode === 404 || response.statusCode >= 500;
            if (canFallbackHost && retryableStatus) {
              this.logger.warn(
                `Retrying ${method} ${requestPath} on fallback host after status ${response.statusCode} from "${targetHost}"`
              );
              continue;
            }
          } else {
            this.logger.debug?.(
              `Upstream HTTPS ${method} ${requestPath} -> ${response.statusCode} via ${targetHost} (${resolvedIp})`
            );
          }
          return response;
        } catch (error) {
          lastError = error;
          this.logger.warn(
            `Generic upstream request failed via ${targetHost} (${resolvedIp}) ${method} ${requestPath}: ${error.message}`
          );
        }
      }
    }

    if (candidateHosts.length === 0) {
      throw new Error(`No upstream host configured for ${method} ${requestPath}`);
    }

    throw lastError || new Error(`No upstream response for ${method} ${requestPath}`);
  }

  async handleServerDataRequest(req, body) {
    const parsedUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = new URLSearchParams(parsedUrl.search);
    const bodyParams = new URLSearchParams(body);
    for (const [key, value] of bodyParams.entries()) {
      params.set(key, value);
    }

    let responseBody = "";
    let selectedHost = "";
    let lastError = null;
    const requiresLoginUrl = params.get("platform") === "0";
    const requestHost = getHostWithoutPort(req.headers.host);
    const candidateHosts = buildUpstreamHostCandidates(requestHost, this.config.server.address);

    for (const targetHost of candidateHosts) {
      // Try each resolved IPv4 for this host so transient edge/CDN failures can fall through.
      const resolvedIps = await this.dnsResolver.resolveIPv4All(targetHost);
      if (resolvedIps.length === 0) {
        this.logger.warn(`Failed to resolve upstream host "${targetHost}"`);
        continue;
      }

      for (const resolvedIp of resolvedIps.slice(0, 2)) {
        try {
          const candidateResponse = await this.proxyServerDataToUpstream(
            resolvedIp,
            targetHost,
            params,
            req.headers["user-agent"] || ""
          );

          if (requiresLoginUrl && !/\nloginurl\|/i.test(`\n${candidateResponse}`)) {
            throw new Error("Missing loginurl in server_data response for platform=0");
          }

          responseBody = candidateResponse;
          selectedHost = targetHost;
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          this.logger.warn(`Upstream request failed via ${targetHost} (${resolvedIp}): ${error.message}`);
        }
      }

      if (!lastError) {
        break;
      }
    }

    if (lastError) {
      throw lastError;
    }

    const passthroughLines = extractServerDataPassthroughLines(responseBody);
    const normalizedBody = normalizeServerDataBody(responseBody);
    const parser = new TextParse(normalizedBody);
    if (parser.empty()) {
      throw new Error("Received unparseable server_data.php response");
    }

    this.pendingAddress = parser.get("server", 0);
    this.pendingPort = parser.getInt("port", 0, 65535);

    if (!parser.contains("type")) {
      parser.set("type", "1");
    }

    parser.set("server", "127.0.0.1");
    parser.set("port", String(this.config.server.port));
    parser.set("type2", "1");

    const maint = parser.get("#maint", 0);
    if (maint) {
      if (this.config.web.ignoreMaintenance !== false) {
        this.logger.debug?.(`Ignoring upstream maintenance flag: ${maint}`);
        parser.remove("#maint");
        parser.remove("maint");
      } else {
        this.logger.warn(`Upstream maintenance flag: ${maint}`);
      }
    }

    if (selectedHost && selectedHost !== this.config.server.address) {
      this.logger.warn(`Using fallback upstream host "${selectedHost}" (configured: "${this.config.server.address}")`);
    }

    let output = parser.getRaw();
    for (const line of passthroughLines) {
      if (output.includes(line)) {
        continue;
      }
      output = output.length > 0 ? `${output}\n${line}` : line;
    }

    this.logger.info(
      `server_data upstream="${selectedHost || "unknown"}" keys: `
      + `loginurl=${parser.get("loginurl", 0) ? "yes" : "no"}, `
      + `server=${parser.get("server", 0)}, port=${parser.get("port", 0)}`
    );

    this.logger.debug(`Modified server_data.php:\n${output}`);
    return output;
  }

  proxyServerDataToUpstream(resolvedIp, targetHost, params, userAgent) {
    const payload = params.toString();

    return new Promise((resolve, reject) => {
      const request = https.request({
        host: resolvedIp,
        servername: targetHost,
        port: 443,
        path: "/growtopia/server_data.php",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Host": targetHost,
          "User-Agent": userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Upstream HTTP status ${response.statusCode}`));
            return;
          }

          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });

      request.setTimeout(2500, () => {
        request.destroy(new Error(`Upstream timeout after 2500ms (${resolvedIp}:443)`));
      });
      request.on("error", reject);
      request.write(payload);
      request.end();
    });
  }

  proxyGenericToUpstream(resolvedIp, targetHost, requestPath, method, incomingHeaders, bodyBuffer) {
    const payload = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || "");
    const headers = {};

    for (const [name, value] of Object.entries(incomingHeaders || {})) {
      const lower = String(name || "").toLowerCase();
      if (!lower || lower === "host" || lower === "content-length" || lower === "connection" || lower === "transfer-encoding") {
        continue;
      }

      if (typeof value === "undefined") {
        continue;
      }

      headers[name] = value;
    }

    headers.Host = targetHost;
    if (payload.length > 0 || method === "POST" || method === "PUT" || method === "PATCH") {
      headers["Content-Length"] = String(payload.length);
    }

    return new Promise((resolve, reject) => {
      const request = https.request({
        host: resolvedIp,
        servername: targetHost,
        port: 443,
        path: requestPath,
        method,
        rejectUnauthorized: false,
        headers
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: Number(response.statusCode || 502),
            headers: response.headers || {},
            body: Buffer.concat(chunks)
          });
        });
      });

      request.setTimeout(2500, () => {
        request.destroy(new Error(`Upstream timeout after 2500ms (${resolvedIp}:443)`));
      });
      request.on("error", reject);
      if (payload.length > 0) {
        request.write(payload);
      }
      request.end();
    });
  }
}

module.exports = {
  ProxyCore
};
