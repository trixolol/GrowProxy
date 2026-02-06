"use strict";

class WorldState {
  constructor() {
    this.players = new Map();
    this.localNetId = -1;
  }

  clear() {
    this.players.clear();
    this.localNetId = -1;
  }

  onSpawn(payload) {
    if (!payload || typeof payload.netId !== "number" || payload.netId < 0) {
      return;
    }

    this.players.set(payload.netId, payload);
    if (payload.type === "local") {
      this.localNetId = payload.netId;
    }
  }

  onRemove(netId) {
    if (typeof netId !== "number" || netId < 0) {
      return;
    }

    this.players.delete(netId);
    if (this.localNetId === netId) {
      this.localNetId = -1;
    }
  }

  getLocalNetId() {
    return this.localNetId;
  }
}

module.exports = {
  WorldState
};
