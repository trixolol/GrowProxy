"use strict";

const dns = require("node:dns");
const net = require("node:net");

const PROVIDERS = {
  cloudflare: ["1.1.1.1", "1.0.0.1"],
  google: ["8.8.8.8", "8.8.4.4"],
  quad9: ["9.9.9.9", "149.112.112.112"],
  system: null
};

class DnsResolver {
  constructor(providerName = "system", logger = console) {
    this.logger = logger;
    this.resolver = new dns.Resolver();
    this.providerName = providerName;

    const lower = String(providerName || "system").toLowerCase();
    const provider = PROVIDERS[lower];
    if (provider && provider.length > 0) {
      this.resolver.setServers(provider);
      this.logger.debug?.(`DNS provider "${lower}" -> ${provider.join(", ")}`);
    } else if (lower.includes(",")) {
      const custom = lower.split(",").map((v) => v.trim()).filter(Boolean);
      if (custom.length > 0) {
        this.resolver.setServers(custom);
        this.logger.debug?.(`DNS provider custom -> ${custom.join(", ")}`);
      }
    }
  }

  async resolveIPv4(hostname) {
    const values = await this.resolveIPv4All(hostname);
    return values[0] ?? "";
  }

  async resolveIPv4All(hostname) {
    if (typeof hostname === "string" && net.isIP(hostname) === 4) {
      return [hostname];
    }

    try {
      const values = await new Promise((resolve, reject) => {
        this.resolver.resolve4(hostname, (error, addresses) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(addresses);
        });
      });
      return Array.isArray(values) ? values : [];
    } catch (error) {
      this.logger.error?.(`DNS resolve failed for "${hostname}": ${error.message}`);
      return [];
    }
  }
}

module.exports = {
  DnsResolver
};
