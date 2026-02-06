"use strict";

class CommandRegistry {
  constructor(prefix = "/") {
    this.prefix = prefix;
    this.commands = new Map();
  }

  normalizeInput(text) {
    if (typeof text !== "string") {
      return "";
    }

    // Some client packets may contain control/NUL bytes around command text.
    // Strip those and allow leading whitespace before the command prefix.
    return text.replace(/[\u0000-\u001f]/g, "").replace(/^\uFEFF/, "").trimStart();
  }

  setPrefix(prefix) {
    if (typeof prefix === "string" && prefix.length === 1) {
      this.prefix = prefix;
    }
  }

  register(name, description, handler) {
    const key = String(name || "").trim().toLowerCase();
    if (!key || typeof handler !== "function") {
      return;
    }

    this.commands.set(key, {
      name: key,
      description: String(description || ""),
      handler
    });
  }

  get(name) {
    const key = String(name || "").trim().toLowerCase();
    return this.commands.get(key) ?? null;
  }

  getAll() {
    return [...this.commands.values()].map((cmd) => [cmd.name, cmd.description]);
  }

  isCommand(text) {
    const normalized = this.normalizeInput(text);
    return normalized.startsWith(this.prefix);
  }

  parse(text) {
    const normalized = this.normalizeInput(text);
    if (!normalized.startsWith(this.prefix)) {
      return null;
    }

    const clean = normalized.slice(this.prefix.length).trim();
    if (!clean) {
      return null;
    }

    const tokens = clean.split(/\s+/g);
    if (tokens.length === 0) {
      return null;
    }

    const rawName = String(tokens.shift() || "").toLowerCase();
    const nameMatch = rawName.match(/^[a-z0-9_-]+/);
    if (!nameMatch) {
      return null;
    }

    const name = nameMatch[0];
    return {
      name,
      args: tokens
    };
  }

  execute(text, context = {}) {
    const parsed = this.parse(text);
    if (!parsed) {
      return false;
    }

    const cmd = this.get(parsed.name);
    if (!cmd) {
      return false;
    }

    try {
      cmd.handler({
        ...context,
        args: parsed.args,
        rawInput: text,
        commandName: parsed.name,
        registry: this
      });
    } catch (error) {
      if (typeof context?.logger?.error === "function") {
        context.logger.error(`Command "${parsed.name}" failed: ${error.message}`);
      }
    }

    return true;
  }
}

module.exports = {
  CommandRegistry
};
