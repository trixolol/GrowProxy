"use strict";

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

const LEVEL_COLORS = {
  error: ANSI.red,
  warn: ANSI.yellow,
  info: ANSI.green,
  debug: ANSI.cyan,
  trace: ANSI.magenta
};

function toTimestamp() {
  return new Date().toISOString();
}

function shouldUseColor() {
  if (String(process.env.NO_COLOR || "") !== "") {
    return false;
  }

  const forced = String(process.env.FORCE_COLOR || "").trim();
  if (forced) {
    return forced !== "0";
  }

  return Boolean(process.stdout && process.stdout.isTTY);
}

function createLogger(level = "info") {
  const normalizedLevel = typeof level === "string" ? level.toLowerCase() : "info";
  const minLevel = LEVELS[normalizedLevel] ?? LEVELS.info;
  const useColor = shouldUseColor();

  function write(method, message, ...args) {
    if (LEVELS[method] > minLevel) {
      return;
    }

    const timestamp = `[${toTimestamp()}]`;
    const levelLabel = `[${method.toUpperCase()}]`;
    const prefix = useColor
      ? `${ANSI.dim}${timestamp}${ANSI.reset} ${LEVEL_COLORS[method] || ""}${levelLabel}${ANSI.reset}`
      : `${timestamp} ${levelLabel}`;
    const fn = method === "error" ? console.error : method === "warn" ? console.warn : console.log;
    fn(prefix, message, ...args);
  }

  return {
    level: normalizedLevel,
    error(message, ...args) {
      write("error", message, ...args);
    },
    warn(message, ...args) {
      write("warn", message, ...args);
    },
    info(message, ...args) {
      write("info", message, ...args);
    },
    debug(message, ...args) {
      write("debug", message, ...args);
    },
    trace(message, ...args) {
      write("trace", message, ...args);
    }
  };
}

module.exports = {
  createLogger
};
