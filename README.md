# GrowProxy

Growtopia proxy built on Node.js with:

- local ENet proxy server (client -> proxy)
- outbound ENet client (proxy -> Growtopia)
- HTTPS interception for `/growtopia/server_data.php`
- packet forwarding + `OnSendToServer` rewrite/handoff
- script-driven command system from `scripts/*.js`

## Highlights

- Node.js 20+ runtime
- colorized logs with levels (`error`, `warn`, `info`, `debug`, `trace`)
- automatic fallback across official upstream hostnames
- automatic self-signed TLS certificate generation for Growtopia domains
- command parsing hardened for control bytes / malformed input text
- script hooks for packet inspection, mutation, and command registration

## Requirements

- Node.js 20 or newer
- Windows/Linux/macOS
- hosts-file access (to map Growtopia domains to localhost)

## Compatibility

- Supported/tested: **Growtopia 5.42** with **protocol 225**
- Last verified: **February 6, 2026**

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start proxy:

```bash
npm start
```

3. Add hosts entries:

```text
127.0.0.1 growtopia1.com
127.0.0.1 www.growtopia1.com
127.0.0.1 growtopia2.com
127.0.0.1 www.growtopia2.com
```

4. Keep proxy running, then launch Growtopia client.

## What Gets Created On First Run

- `config.json` if missing (generated from defaults)
- `resources/cert.pem` and `resources/key.pem` if missing or incompatible
- script directory from `scripts.path` if it does not exist

## Project Structure

```text
GrowProxy/
  .gitignore
  LICENSE
  README.md
  config.example.json
  package.json
  src/
    builtinCommands.js
    commandRegistry.js
    config.js
    dnsResolver.js
    hostsCheck.js
    index.js            # startup, port checks, process lifecycle
    logger.js           # colorized logger
    packet.js           # packet parse/build/variant encoding
    ports.js
    proxyCore.js        # ENet + HTTPS proxy core
    scriptManager.js    # script discovery/loading
    taskScheduler.js
    textParse.js
    tls.js
    worldState.js
  scripts/
    coreCommands.js     # script-based core commands
  resources/
    cert.pem            # generated locally at runtime
    key.pem             # generated locally at runtime
```

## How It Works

1. Client calls `https://www.growtopia1.com/growtopia/server_data.php`.
2. Proxy forwards that request upstream, parses response, rewrites:
   - `server|127.0.0.1`
   - `port|<config.server.port>`
3. Growtopia client connects ENet to your local proxy.
4. Proxy receives `OnSendToServer`, stores real upstream `ip:port`, rewrites route for client, then performs upstream ENet connect.
5. Traffic is forwarded both directions with optional script interception/mutation.

## Configuration

`config.json` is merged with defaults in `src/config.js`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `server.port` | number | `16999` | Local ENet port used by Growtopia client |
| `server.address` | string | `www.growtopia1.com` | Preferred upstream host for HTTPS proxying |
| `client.gameVersion` | string | `5.42` | Reserved config value (not forced into packets) |
| `client.protocol` | number | `225` | Reserved config value (not forced into packets) |
| `client.dnsServer` | string | `cloudflare` | `cloudflare`, `google`, `quad9`, `system`, or comma-separated servers |
| `client.localPort` | number | `0` | Outbound ENet local UDP bind (`0` = ephemeral) |
| `log.level` | string | `info` | `error`, `warn`, `info`, `debug`, `trace` |
| `log.printMessage` | bool | `true` | Log text packets |
| `log.printGameUpdatePacket` | bool | `false` | Log tank packet header hex |
| `log.printVariant` | bool | `true` | Log decoded variant payloads |
| `log.printExtra` | bool | `true` | Log extra payload hex for non-variant tank packets |
| `command.prefix` | string | `/` | One-character prefix |
| `web.port` | number | `443` | HTTPS intercept listener |
| `web.certPath` | string | `resources/cert.pem` | TLS certificate path |
| `web.keyPath` | string | `resources/key.pem` | TLS key path |
| `web.ignoreMaintenance` | bool | `true` | Removes upstream `#maint` in `server_data.php` response |
| `scripts.enabled` | bool | `true` | Enable script loading |
| `scripts.path` | string | `scripts` | Script directory |

## Commands

### Built-in (core)

- `/proxyhelp` shows available commands
- `/exit` stops the proxy process

### Script-based (`scripts/coreCommands.js`)

- `/proxy` basic test message
- `/warp <world>` sends `quit_to_exit`, then delayed `join_request`
- `/nick <nickname>` local display-name variant to client
- `/skin [hex] <code>` local skin variant to client

Notes:

- If `scripts.enabled` is `false`, script-defined commands are not loaded.

## Script API

Each script must export:

```js
module.exports.register = function register(api) {
  // register commands, packet hooks, etc.
};
```

### `api` object

- `api.registerCommand(name, description, handler)`
- `api.on(eventName, callback)`
- `api.logger` (`error/warn/info/debug/trace`)
- `api.config` (runtime config object)

### Command handler context (`handler(ctx)`)

- `ctx.args` string array
- `ctx.rawInput` original input text
- `ctx.commandName` normalized command name
- `ctx.registry` command registry (includes `prefix`, `get`, `getAll`)
- `ctx.logger`
- `ctx.proxy`

Useful `ctx.proxy` methods/properties:

- `sendLog(message)`
- `sendQuitToExit()`
- `sendJoinRequest(worldName, invitedWorld)`
- `sendVariantToClient(functionName, args, options)`
- `sendToServer(buffer, channelId)`
- `sendToClient(buffer, channelId)`
- `isServerConnected()`
- `stop()`
- `world.getLocalNetId()`
- `scheduler.scheduleDelayed(fn, delayMs, tag)`
- `scheduler.cancelByTag(tag)`

### Packet hook events

- `serverBoundPacket` (client -> server direction)
- `clientBoundPacket` (server -> client direction)

Hook context fields:

- `context.direction`
- `context.channelId`
- `context.parsed` (decoded packet object)
- `context.raw` (`Buffer`, mutable)
- `context.canceled` (`boolean`, set `true` to drop packet)

## Script Examples

### 1) Add a basic command

```js
"use strict";

module.exports.register = function register(api) {
  api.registerCommand("hello", "Simple hello command.", (ctx) => {
    ctx.proxy.sendLog("Hello from script.");
  });
};
```

### 2) Show current upstream connectivity

```js
"use strict";

module.exports.register = function register(api) {
  api.registerCommand("upstream", "Show whether upstream ENet is connected.", (ctx) => {
    const connected = ctx.proxy.isServerConnected() ? "connected" : "not connected";
    ctx.proxy.sendLog(`Upstream is currently ${connected}.`);
  });
};
```

### 3) Packet hook example (inspect input packets)

```js
"use strict";

module.exports.register = function register(api) {
  api.on("serverBoundPacket", (event) => {
    if (event?.parsed?.packetId === "Input") {
      api.logger.debug(`Input packet captured: ${event.parsed.inputText || "<empty>"}`);
    }
  });
};
```

## Troubleshooting

### Stuck on "Located server, connecting"

- Verify hosts mappings point to `127.0.0.1`, not `0.0.0.0`.
- Verify proxy is listening on configured ports.
- Check logs for `Initiated upstream ENet connect` and `Connected to Growtopia server`.

### `Cannot bind HTTPS port 443`

- Another process is using port `443`.
- Stop that process or change `config.web.port`.

### Commands show "Unknown command"

- Ensure script file exists in `scripts/` and exports `register(api)`.
- Confirm startup log says `Loaded script <file>.js`.
- Confirm command prefix matches `config.command.prefix`.

### Frequent reconnects / high delay

- Keep `client.localPort = 0` unless you specifically need a fixed local UDP source port.
- Check local firewall/AV UDP filtering.
- Reduce verbose logging if needed (`log.printVariant`, `log.printExtra`) to lower console overhead.

## Security and Logging Notes

- Packet logs can include account/session values (tokens, UUIDs, metadata).
- Avoid sharing raw logs publicly.

## Libraries Used

Runtime dependencies:

- [`growtopia.js`](https://github.com/StileDevs/growtopia.js) (ENet client/server integration for Growtopia traffic)
- `selfsigned` (self-signed TLS certificate generation)

## License

This project is licensed under **PolyForm Noncommercial 1.0.0**. See `LICENSE`.

Practical summary:

- Allowed: personal use, modification, and sharing under license terms.
- Not allowed: commercial use (selling, paid access, revenue-generating usage, etc.).

## Disclaimer

This project is intended for educational and research purposes only. You are responsible for how you use it, including compliance with game terms, and platform policies. The authors provide this software as-is, without warranty or liability for misuse.
