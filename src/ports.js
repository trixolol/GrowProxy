"use strict";

const dgram = require("node:dgram");
const net = require("node:net");

function checkUdpPortAvailable(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");

    socket.once("error", () => {
      socket.close();
      resolve(false);
    });

    socket.bind(port, host, () => {
      socket.close(() => resolve(true));
    });
  });
}

function checkTcpPortAvailable(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreeUdpPort(startPort, endPort = 65535, host = "0.0.0.0") {
  let start = Number(startPort);
  let end = Number(endPort);

  if (!Number.isInteger(start) || start <= 0) {
    start = 1024;
  }

  if (!Number.isInteger(end) || end < start) {
    end = start;
  }

  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const available = await checkUdpPortAvailable(port, host);
    if (available) {
      return port;
    }
  }

  return -1;
}

module.exports = {
  checkUdpPortAvailable,
  checkTcpPortAvailable,
  findFreeUdpPort
};
