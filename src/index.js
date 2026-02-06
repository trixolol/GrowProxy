"use strict";

const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { ProxyCore } = require("./proxyCore");
const { checkUdpPortAvailable, checkTcpPortAvailable, findFreeUdpPort } = require("./ports");
const { checkGrowtopiaHostMappings } = require("./hostsCheck");

async function resolveRuntimePorts(config, logger) {
  const serverPortAvailable = await checkUdpPortAvailable(config.server.port);
  if (!serverPortAvailable) {
    const replacement = await findFreeUdpPort(config.server.port + 1, Math.min(config.server.port + 200, 65535));
    if (replacement < 0) {
      throw new Error(
        `Cannot bind proxy UDP port ${config.server.port}. No free replacement found in range `
        + `${config.server.port + 1}-${Math.min(config.server.port + 200, 65535)}.`
      );
    }

    logger.warn(`UDP port ${config.server.port} is busy. Switching proxy server port to ${replacement}.`);
    config.server.port = replacement;
  }

  if (config.client.localPort > 0) {
    const clientPortAvailable = await checkUdpPortAvailable(config.client.localPort);
    if (!clientPortAvailable) {
      logger.warn(
        `UDP port ${config.client.localPort} for client.localPort is busy. Falling back to ephemeral port (0).`
      );
      config.client.localPort = 0;
    }
  }

  const webPortAvailable = await checkTcpPortAvailable(config.web.port);
  if (!webPortAvailable) {
    throw new Error(
      `Cannot bind HTTPS port ${config.web.port}. Stop the process using it or change config.web.port.`
    );
  }
}

async function main() {
  const { config, path: configPath } = loadConfig("config.json");
  const logger = createLogger(config.log.level);

  logger.info(`Loaded config from ${configPath}`);
  logger.info("Starting GrowProxy Node...");
  checkGrowtopiaHostMappings(logger, config);
  await resolveRuntimePorts(config, logger);

  const proxy = new ProxyCore(config, logger);

  const stop = () => {
    logger.info("Stopping proxy...");
    proxy.stop();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await proxy.start();
}

main().catch((error) => {
  console.error(`[FATAL] ${error.stack || error.message}`);
  process.exit(1);
});
