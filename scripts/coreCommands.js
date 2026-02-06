"use strict";

module.exports.register = function register(api) {
  api.registerCommand("proxy", "A simple command to test the proxy.", (ctx) => {
    ctx.proxy.sendLog("Proxy command executed successfully!");
  });

  api.registerCommand("warp", "Warp to a world.", (ctx) => {
    if (!ctx.args || ctx.args.length === 0) {
      ctx.proxy.sendLog(`\`4Usage: \`\`${ctx.registry.prefix}warp <world name>`);
      return;
    }

    const worldName = String(ctx.args[0] || "");
    if (!worldName) {
      ctx.proxy.sendLog(`\`4Usage: \`\`${ctx.registry.prefix}warp <world name>`);
      return;
    }

    if (worldName.toLowerCase() === "exit") {
      ctx.proxy.sendLog("\`4Oops: \`\`You cannot warp to the exit world.");
      return;
    }

    if (worldName.length > 23) {
      ctx.proxy.sendLog("\`4Error: \`\`World name cannot exceed 23 characters.");
      return;
    }

    ctx.proxy.scheduler.cancelByTag("warp");
    ctx.proxy.sendQuitToExit();
    ctx.proxy.sendLog(`Warping to ${worldName}...`);

    ctx.proxy.scheduler.scheduleDelayed(() => {
      if (!ctx.proxy.isServerConnected()) {
        api.logger.warn("Server disconnected before warp completed.");
        return;
      }

      ctx.proxy.sendJoinRequest(worldName, false);
    }, 1750, "warp");
  });

  api.registerCommand("nick", "Change your display name.", (ctx) => {
    if (!ctx.args || ctx.args.length === 0) {
      ctx.proxy.sendLog(`\`4Usage: \`\`${ctx.registry.prefix}nick <nickname>`);
      return;
    }

    const nickname = ctx.args.join(" ");
    ctx.proxy.sendVariantToClient("OnNameChanged", [nickname], {
      netId: ctx.proxy.world.getLocalNetId()
    });
    ctx.proxy.sendLog(`Display name changed to ${nickname}`);
  });

  api.registerCommand("skin", "Change your skin code.", (ctx) => {
    if (!ctx.args || ctx.args.length === 0) {
      ctx.proxy.sendLog(`\`4Usage: \`\`${ctx.registry.prefix}skin [hex] <code>`);
      return;
    }

    let isHex = false;
    let value = String(ctx.args[0] || "");
    if (value.toLowerCase() === "hex" && ctx.args.length > 1) {
      isHex = true;
      value = String(ctx.args[1] || "");
    }

    const parsed = Number.parseInt(value, isHex ? 16 : 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
      ctx.proxy.sendLog(`\`4Oops: \`\`Invalid skin code: ${value}`);
      return;
    }

    ctx.proxy.sendVariantToClient("OnChangeSkin", [parsed], {
      netId: ctx.proxy.world.getLocalNetId()
    });
    ctx.proxy.sendLog(`Skin changed to ${value}`);
  });

  api.logger.info("coreCommands.js loaded");
};
