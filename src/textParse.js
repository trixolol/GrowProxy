"use strict";

class TextParse {
  constructor(raw = "", delimiter = "|") {
    this.entries = [];
    if (raw) {
      this.parse(raw, delimiter);
    }
  }

  static tokenize(raw, delimiter = "|", keepEmpty = true) {
    if (typeof raw !== "string" || raw.length === 0) {
      return [];
    }

    const split = raw.split(delimiter);
    const out = [];

    for (const token of split) {
      if (token.length === 0 && out.length === 0) {
        continue;
      }

      if (token.length === 0 && !keepEmpty) {
        continue;
      }

      out.push(token);
    }

    return out;
  }

  parse(raw, delimiter = "|") {
    this.entries = [];

    if (typeof raw !== "string" || raw.length === 0) {
      return;
    }

    const lines = raw.split("\n");
    for (const line of lines) {
      const tokens = TextParse.tokenize(line, delimiter, true);
      if (tokens.length < 2) {
        continue;
      }

      const key = tokens[0];
      const values = tokens.slice(1);
      this.entries.push([key, values]);
    }
  }

  add(key, ...values) {
    this.entries.push([String(key), values.map((v) => String(v))]);
  }

  set(key, ...values) {
    const target = String(key);
    const idx = this.entries.findIndex((entry) => entry[0] === target);
    const normalized = values.map((v) => String(v));
    if (idx >= 0) {
      this.entries[idx][1] = normalized;
      return;
    }

    this.entries.push([target, normalized]);
  }

  remove(key) {
    const target = String(key);
    this.entries = this.entries.filter((entry) => entry[0] !== target);
  }

  get(key, index = 0) {
    const target = String(key);
    const found = this.entries.find((entry) => entry[0] === target);
    if (!found) {
      return "";
    }

    if (index < 0 || index >= found[1].length) {
      return "";
    }

    return found[1][index];
  }

  getInt(key, index = 0, fallback = 0) {
    const value = this.get(key, index);
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  contains(key) {
    const target = String(key);
    return this.entries.some((entry) => entry[0] === target);
  }

  empty() {
    return this.entries.length === 0;
  }

  getEntries() {
    return this.entries.map(([key, values]) => [key, [...values]]);
  }

  getRaw(delimiter = "|", prependText = "") {
    const lines = [];

    for (let i = 0; i < this.entries.length; i += 1) {
      const [key, values] = this.entries[i];
      let line = `${prependText}${key}`;
      for (const value of values) {
        line += `${delimiter}${value}`;
      }

      lines.push(line);
    }

    return lines.join("\n");
  }
}

module.exports = {
  TextParse
};
