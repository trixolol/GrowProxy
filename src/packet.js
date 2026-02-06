"use strict";

const { TextParse } = require("./textParse");

const NET_MESSAGE = {
  UNKNOWN: 0,
  SERVER_HELLO: 1,
  GENERIC_TEXT: 2,
  GAME_MESSAGE: 3,
  GAME_PACKET: 4
};

const GAME_PACKET = {
  CALL_FUNCTION: 1,
  DISCONNECT: 26
};

const VARIANT_TYPE = {
  FLOAT: 1,
  STRING: 2,
  VEC2: 3,
  VEC3: 4,
  UNSIGNED: 5,
  SIGNED: 9
};

const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

const PacketId = {
  ServerHello: "ServerHello",
  Quit: "Quit",
  QuitToExit: "QuitToExit",
  JoinRequest: "JoinRequest",
  ValidateWorld: "ValidateWorld",
  Input: "Input",
  Log: "Log",
  Disconnect: "Disconnect",
  OnSendToServer: "OnSendToServer",
  OnSpawn: "OnSpawn",
  OnRemove: "OnRemove",
  OnNameChanged: "OnNameChanged",
  OnChangeSkin: "OnChangeSkin",
  Unknown: "Unknown"
};

const ACTION_PACKET_MAP = {
  quit: PacketId.Quit,
  quit_to_exit: PacketId.QuitToExit,
  join_request: PacketId.JoinRequest,
  validate_world: PacketId.ValidateWorld,
  input: PacketId.Input,
  log: PacketId.Log
};

const VARIANT_FUNCTION_MAP = {
  OnSendToServer: PacketId.OnSendToServer,
  OnSpawn: PacketId.OnSpawn,
  OnRemove: PacketId.OnRemove,
  OnNameChanged: PacketId.OnNameChanged,
  OnChangeSkin: PacketId.OnChangeSkin
};

function stripNullTerminator(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return Buffer.alloc(0);
  }

  if (buffer.length > 0 && buffer[buffer.length - 1] === 0) {
    return buffer.subarray(0, buffer.length - 1);
  }

  return buffer;
}

function ensureNullTerminator(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return Buffer.from([0]);
  }

  if (buffer.length > 0 && buffer[buffer.length - 1] === 0) {
    return buffer;
  }

  return Buffer.concat([buffer, Buffer.from([0])]);
}

function toHex(buffer, max = 256) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return "";
  }

  const clipped = buffer.length > max ? buffer.subarray(0, max) : buffer;
  const hex = clipped.toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
  if (buffer.length > max) {
    return `${hex} ...(${buffer.length - max} more bytes)`;
  }

  return hex;
}

function parseTextPacket(rawBuffer) {
  const buffer = stripNullTerminator(rawBuffer);
  if (buffer.length < 4) {
    return null;
  }

  const messageType = buffer.readUInt32LE(0);
  const message = buffer.subarray(4).toString("utf8");
  const parser = new TextParse(message);

  let packetId = PacketId.Unknown;
  if (messageType === NET_MESSAGE.SERVER_HELLO) {
    packetId = PacketId.ServerHello;
  } else {
    const action = parser.get("action", 0);
    packetId = ACTION_PACKET_MAP[action] ?? PacketId.Unknown;
  }

  let inputText = "";
  if (packetId === PacketId.Input) {
    inputText = parser.get("text", 0);
    if (!inputText) {
      const emptyKey = parser.get("", 1);
      inputText = emptyKey || "";
    }
  }

  return {
    kind: "text",
    messageType,
    text: message,
    parser,
    packetId,
    inputText
  };
}

function parseVariantArgs(extraBuffer) {
  const parsed = parseVariantEntries(extraBuffer);
  if (!parsed) {
    return [];
  }

  const args = [];
  for (const entry of parsed.entries) {
    args[entry.index] = entry.value;
  }

  return args;
}

function parseVariantEntries(extraBuffer) {
  if (!Buffer.isBuffer(extraBuffer) || extraBuffer.length === 0) {
    return {
      count: 0,
      entries: []
    };
  }

  if (extraBuffer.length < 1) {
    return null;
  }

  let pos = 0;
  const count = extraBuffer.readUInt8(pos);
  pos += 1;
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (pos + 2 > extraBuffer.length) {
      return null;
    }

    const entryStart = pos;
    const index = extraBuffer.readUInt8(pos);
    pos += 1;

    const type = extraBuffer.readUInt8(pos);
    pos += 1;
    let value = null;

    if (type === VARIANT_TYPE.FLOAT) {
      if (pos + 4 > extraBuffer.length) {
        return null;
      }

      value = extraBuffer.readFloatLE(pos);
      pos += 4;
    } else if (type === VARIANT_TYPE.STRING) {
      if (pos + 4 > extraBuffer.length) {
        return null;
      }

      const strLen = extraBuffer.readUInt32LE(pos);
      pos += 4;
      if (pos + strLen > extraBuffer.length) {
        return null;
      }

      value = extraBuffer.subarray(pos, pos + strLen).toString("utf8");
      pos += strLen;
    } else if (type === VARIANT_TYPE.VEC2) {
      if (pos + 8 > extraBuffer.length) {
        return null;
      }

      value = [extraBuffer.readFloatLE(pos), extraBuffer.readFloatLE(pos + 4)];
      pos += 8;
    } else if (type === VARIANT_TYPE.VEC3) {
      if (pos + 12 > extraBuffer.length) {
        return null;
      }

      value = [
        extraBuffer.readFloatLE(pos),
        extraBuffer.readFloatLE(pos + 4),
        extraBuffer.readFloatLE(pos + 8)
      ];
      pos += 12;
    } else if (type === VARIANT_TYPE.UNSIGNED) {
      if (pos + 4 > extraBuffer.length) {
        return null;
      }

      value = extraBuffer.readUInt32LE(pos);
      pos += 4;
    } else if (type === VARIANT_TYPE.SIGNED) {
      if (pos + 4 > extraBuffer.length) {
        return null;
      }

      value = extraBuffer.readInt32LE(pos);
      pos += 4;
    } else {
      return null;
    }

    const entryEnd = pos;
    entries.push({
      index,
      type,
      value,
      encoded: Buffer.from(extraBuffer.subarray(entryStart, entryEnd))
    });
  }

  return {
    count,
    entries
  };
}

function buildVariantEntry(index, type, value) {
  const indexBuffer = Buffer.from([index & 0xff, type & 0xff]);

  if (type === VARIANT_TYPE.STRING) {
    const text = Buffer.from(String(value ?? ""), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(text.length, 0);
    return Buffer.concat([indexBuffer, len, text]);
  }

  if (type === VARIANT_TYPE.UNSIGNED) {
    const data = Buffer.alloc(4);
    data.writeUInt32LE((Number(value) >>> 0), 0);
    return Buffer.concat([indexBuffer, data]);
  }

  if (type === VARIANT_TYPE.SIGNED) {
    const data = Buffer.alloc(4);
    data.writeInt32LE((Number(value) | 0), 0);
    return Buffer.concat([indexBuffer, data]);
  }

  if (type === VARIANT_TYPE.FLOAT) {
    const data = Buffer.alloc(4);
    data.writeFloatLE(Number(value) || 0, 0);
    return Buffer.concat([indexBuffer, data]);
  }

  if (type === VARIANT_TYPE.VEC2 || type === VARIANT_TYPE.VEC3) {
    const vec = Array.isArray(value) ? value : [];
    const count = type === VARIANT_TYPE.VEC2 ? 2 : 3;
    const data = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i += 1) {
      data.writeFloatLE(Number(vec[i]) || 0, i * 4);
    }
    return Buffer.concat([indexBuffer, data]);
  }

  return null;
}

function encodeVariantEntries(parsed) {
  if (!parsed || !Array.isArray(parsed.entries)) {
    return Buffer.alloc(0);
  }

  const chunks = [Buffer.from([parsed.count & 0xff])];
  for (const entry of parsed.entries) {
    if (Buffer.isBuffer(entry.encoded)) {
      chunks.push(entry.encoded);
      continue;
    }

    const built = buildVariantEntry(entry.index, entry.type, entry.value);
    if (!built) {
      return Buffer.alloc(0);
    }
    chunks.push(built);
  }

  return Buffer.concat(chunks);
}

function rewriteOnSendToServerExtra(extraBuffer, newAddress, newPort) {
  const parsed = parseVariantEntries(extraBuffer);
  if (!parsed || parsed.entries.length === 0) {
    return null;
  }

  const functionEntry = parsed.entries.find((entry) => entry.index === 0);
  if (!functionEntry || functionEntry.type !== VARIANT_TYPE.STRING || functionEntry.value !== "OnSendToServer") {
    return null;
  }

  const portEntry = parsed.entries.find((entry) => entry.index === 1);
  const routeEntry = parsed.entries.find((entry) => entry.index === 4);
  if (!portEntry || !routeEntry || routeEntry.type !== VARIANT_TYPE.STRING) {
    return null;
  }

  const routeText = typeof routeEntry.value === "string" ? routeEntry.value : "";
  const separatorIndex = routeText.indexOf("|");
  const rewrittenRoute = separatorIndex >= 0
    ? `${String(newAddress || "127.0.0.1")}${routeText.slice(separatorIndex)}`
    : String(newAddress || "127.0.0.1");

  portEntry.value = Number(newPort) || 0;
  portEntry.encoded = buildVariantEntry(
    portEntry.index,
    portEntry.type === VARIANT_TYPE.SIGNED || portEntry.type === VARIANT_TYPE.UNSIGNED
      ? portEntry.type
      : VARIANT_TYPE.UNSIGNED,
    portEntry.value
  );

  routeEntry.value = rewrittenRoute;
  routeEntry.encoded = buildVariantEntry(routeEntry.index, VARIANT_TYPE.STRING, routeEntry.value);

  const encoded = encodeVariantEntries(parsed);
  return encoded.length > 0 ? encoded : null;
}

function encodeVariantArgs(args) {
  const normalized = Array.isArray(args) ? args : [];
  const chunks = [Buffer.from([normalized.length])];

  for (let i = 0; i < normalized.length; i += 1) {
    const value = normalized[i];
    chunks.push(Buffer.from([i]));

    if (typeof value === "string") {
      const strBuffer = Buffer.from(value, "utf8");
      const header = Buffer.alloc(5);
      header.writeUInt8(VARIANT_TYPE.STRING, 0);
      header.writeUInt32LE(strBuffer.length, 1);
      chunks.push(header);
      chunks.push(strBuffer);
      continue;
    }

    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        if (value >= 0 && value <= UINT32_MAX) {
          const data = Buffer.alloc(5);
          data.writeUInt8(VARIANT_TYPE.UNSIGNED, 0);
          data.writeUInt32LE(value, 1);
          chunks.push(data);
          continue;
        }

        if (value >= INT32_MIN && value <= INT32_MAX) {
          const data = Buffer.alloc(5);
          data.writeUInt8(VARIANT_TYPE.SIGNED, 0);
          data.writeInt32LE(value, 1);
          chunks.push(data);
          continue;
        }

        // Out-of-range integers are encoded as strings to avoid hard crashes.
        const asText = Buffer.from(String(value), "utf8");
        const header = Buffer.alloc(5);
        header.writeUInt8(VARIANT_TYPE.STRING, 0);
        header.writeUInt32LE(asText.length, 1);
        chunks.push(header);
        chunks.push(asText);
        continue;
      }

      if (!Number.isFinite(value)) {
        const asText = Buffer.from(String(value), "utf8");
        const header = Buffer.alloc(5);
        header.writeUInt8(VARIANT_TYPE.STRING, 0);
        header.writeUInt32LE(asText.length, 1);
        chunks.push(header);
        chunks.push(asText);
        continue;
      }

      const data = Buffer.alloc(5);
      data.writeUInt8(VARIANT_TYPE.FLOAT, 0);
      data.writeFloatLE(value, 1);
      chunks.push(data);
      continue;
    }

    if (Array.isArray(value) && value.length >= 2 && value.length <= 3) {
      const type = value.length === 2 ? VARIANT_TYPE.VEC2 : VARIANT_TYPE.VEC3;
      const data = Buffer.alloc(1 + value.length * 4);
      data.writeUInt8(type, 0);
      for (let j = 0; j < value.length; j += 1) {
        data.writeFloatLE(Number(value[j]) || 0, 1 + j * 4);
      }

      chunks.push(data);
      continue;
    }

    const fallback = Buffer.alloc(5);
    fallback.writeUInt8(VARIANT_TYPE.STRING, 0);
    fallback.writeUInt32LE(0, 1);
    chunks.push(fallback);
  }

  return Buffer.concat(chunks);
}

function parseTankPacket(rawBuffer) {
  const buffer = stripNullTerminator(rawBuffer);
  if (buffer.length < 60) {
    return null;
  }

  const messageType = buffer.readUInt32LE(0);
  if (messageType !== NET_MESSAGE.GAME_PACKET) {
    return null;
  }

  const type = buffer.readUInt8(4);
  const netId = buffer.readInt32LE(8);
  const targetNetId = buffer.readInt32LE(12);
  const state = buffer.readUInt32LE(16);
  const info = buffer.readInt32LE(24);
  const dataSize = buffer.readUInt32LE(56);
  const extraEnd = Math.min(buffer.length, 60 + dataSize);
  const extra = extraEnd > 60 ? buffer.subarray(60, extraEnd) : Buffer.alloc(0);
  const header = Buffer.from(buffer.subarray(0, 60));

  let packetId = PacketId.Unknown;
  let variantFunction = "";
  let variantArgs = null;

  if (type === GAME_PACKET.DISCONNECT) {
    packetId = PacketId.Disconnect;
  }

  if (type === GAME_PACKET.CALL_FUNCTION) {
    variantArgs = parseVariantArgs(extra);
    variantFunction = typeof variantArgs[0] === "string" ? variantArgs[0] : "";
    packetId = VARIANT_FUNCTION_MAP[variantFunction] ?? PacketId.Unknown;
  }

  return {
    kind: "tank",
    messageType,
    packetType: type,
    netId,
    targetNetId,
    state,
    info,
    dataSize,
    extra,
    header,
    packetId,
    variantFunction,
    variantArgs
  };
}

function parsePacket(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 4) {
    return {
      kind: "raw",
      packetId: PacketId.Unknown
    };
  }

  const messageType = rawBuffer.readUInt32LE(0);
  if (
    messageType === NET_MESSAGE.SERVER_HELLO
    || messageType === NET_MESSAGE.GENERIC_TEXT
    || messageType === NET_MESSAGE.GAME_MESSAGE
  ) {
    return parseTextPacket(rawBuffer) ?? { kind: "raw", packetId: PacketId.Unknown };
  }

  if (messageType === NET_MESSAGE.GAME_PACKET) {
    return parseTankPacket(rawBuffer) ?? { kind: "raw", packetId: PacketId.Unknown };
  }

  return {
    kind: "raw",
    packetId: PacketId.Unknown
  };
}

function buildTextPacket(messageType, rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  const textBuffer = Buffer.from(text, "utf8");
  const out = Buffer.alloc(4 + textBuffer.length + 1);
  out.writeUInt32LE(messageType, 0);
  textBuffer.copy(out, 4);
  return out;
}

function buildTankPacket({
  header = null,
  packetType = GAME_PACKET.CALL_FUNCTION,
  netId = -1,
  targetNetId = 0,
  state = 8,
  info = 0,
  extra = Buffer.alloc(0)
} = {}) {
  const headerBuffer = header && Buffer.isBuffer(header) ? Buffer.from(header) : Buffer.alloc(60);
  if (headerBuffer.length < 60) {
    throw new Error("Tank header must be at least 60 bytes");
  }

  headerBuffer.writeUInt32LE(NET_MESSAGE.GAME_PACKET, 0);
  headerBuffer.writeUInt8(packetType, 4);
  headerBuffer.writeInt32LE(netId, 8);
  headerBuffer.writeInt32LE(targetNetId, 12);
  headerBuffer.writeUInt32LE(state, 16);
  headerBuffer.writeInt32LE(info, 24);
  headerBuffer.writeUInt32LE(extra.length, 56);

  return Buffer.concat([headerBuffer.subarray(0, 60), extra]);
}

function parseOnSendToServer(variantArgs) {
  if (!Array.isArray(variantArgs) || variantArgs.length < 5) {
    return null;
  }

  const port = Number(variantArgs[1]) || 0;
  const token = Number(variantArgs[2]) || 0;
  const user = Number(variantArgs[3]) || 0;
  const rawText = typeof variantArgs[4] === "string" ? variantArgs[4] : "";
  const loginMode = Number(variantArgs[5] ?? 0) || 0;
  const username = typeof variantArgs[6] === "string" ? variantArgs[6] : "";

  const key = rawText.split("|", 1)[0] ?? "";
  const text = new TextParse(rawText);

  return {
    port,
    token,
    user,
    address: key,
    doorId: text.get(key, 0),
    uuidToken: text.get(key, 1),
    loginMode,
    username
  };
}

function buildOnSendToServerArgs(payload, address, port, originalArgs = null) {
  const parser = new TextParse();
  parser.add(address, payload.doorId ?? "", payload.uuidToken ?? "");

  const out = Array.isArray(originalArgs) ? [...originalArgs] : [];
  out[0] = "OnSendToServer";
  out[1] = Number(port) || 0;
  out[2] = Number(payload.token) || 0;
  out[3] = Number(payload.user) || 0;
  out[4] = parser.getRaw();
  out[5] = Number(payload.loginMode) || 0;
  out[6] = payload.username ?? "";
  return out;
}

function parseOnSpawn(variantArgs) {
  if (!Array.isArray(variantArgs) || variantArgs.length < 2 || typeof variantArgs[1] !== "string") {
    return null;
  }

  const parser = new TextParse(variantArgs[1]);
  return {
    spawn: parser.get("spawn", 0),
    netId: parser.getInt("netID", 0, -1),
    userId: parser.getInt("userID", 0, 0),
    name: parser.get("name", 0),
    type: parser.get("type", 0)
  };
}

function parseOnRemove(variantArgs) {
  if (!Array.isArray(variantArgs) || variantArgs.length < 2) {
    return null;
  }

  const netData = typeof variantArgs[1] === "string" ? variantArgs[1] : "";
  const parser = new TextParse(netData);
  const netId = parser.getInt("netID", 0, -1);
  return { netId };
}

module.exports = {
  NET_MESSAGE,
  GAME_PACKET,
  PacketId,
  stripNullTerminator,
  ensureNullTerminator,
  toHex,
  parsePacket,
  parseVariantArgs,
  parseVariantEntries,
  encodeVariantArgs,
  rewriteOnSendToServerExtra,
  buildTextPacket,
  buildTankPacket,
  parseOnSendToServer,
  buildOnSendToServerArgs,
  parseOnSpawn,
  parseOnRemove
};
