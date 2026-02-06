"use strict";

const fs = require("node:fs");
const path = require("node:path");

class ScriptManager {
  constructor(config = {}, logger = console) {
    this.config = {
      enabled: config.enabled !== false,
      path: config.path || "scripts"
    };
    this.logger = logger;
  }

  load(api) {
    if (!this.config.enabled) {
      this.logger.info("Script manager disabled by config.");
      return;
    }

    const scriptDir = path.resolve(this.config.path);
    fs.mkdirSync(scriptDir, { recursive: true });

    const files = fs
      .readdirSync(scriptDir)
      .filter((entry) => entry.endsWith(".js"))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const fullPath = path.join(scriptDir, file);
      try {
        delete require.cache[require.resolve(fullPath)];
        const mod = require(fullPath);
        if (typeof mod.register === "function") {
          mod.register(api);
          this.logger.info(`Loaded script ${file}`);
        } else {
          this.logger.warn(`Ignored script ${file} (missing register(api) export)`);
        }
      } catch (error) {
        this.logger.error(`Failed to load script ${file}: ${error.message}`);
      }
    }
  }
}

module.exports = {
  ScriptManager
};
