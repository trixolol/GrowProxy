"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate } = require("node:crypto");
const selfsigned = require("selfsigned");

const REQUIRED_DNS_NAMES = [
  "growtopia1.com",
  "www.growtopia1.com",
  "growtopia2.com",
  "www.growtopia2.com"
];

function certNeedsRegeneration(certPem) {
  try {
    const cert = new X509Certificate(certPem);
    const san = String(cert.subjectAltName || "");
    for (const name of REQUIRED_DNS_NAMES) {
      if (!san.includes(`DNS:${name}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function ensureTlsCertificate(certPath, keyPath, logger = console) {
  const certResolved = path.resolve(certPath);
  const keyResolved = path.resolve(keyPath);

  if (fs.existsSync(certResolved) && fs.existsSync(keyResolved)) {
    const certPem = fs.readFileSync(certResolved, "utf8");
    if (!certNeedsRegeneration(certPem)) {
      return;
    }

    logger.warn?.("Existing TLS cert is incompatible with Growtopia hostnames. Regenerating...");
  }

  fs.mkdirSync(path.dirname(certResolved), { recursive: true });
  fs.mkdirSync(path.dirname(keyResolved), { recursive: true });

  const attrs = [{ name: "commonName", value: "growtopia1.com" }];
  const pems = selfsigned.generate(attrs, {
    algorithm: "sha256",
    keySize: 2048,
    days: 3650,
    extensions: [
      {
        name: "subjectAltName",
        altNames: REQUIRED_DNS_NAMES.map((value) => ({ type: 2, value }))
      }
    ]
  });

  fs.writeFileSync(certResolved, pems.cert, "utf8");
  fs.writeFileSync(keyResolved, pems.private, "utf8");
  logger.warn?.(`Generated Growtopia-compatible self-signed cert at "${certResolved}"`);
}

module.exports = {
  ensureTlsCertificate
};
