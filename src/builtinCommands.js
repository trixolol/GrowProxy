"use strict";

function registerBuiltinCommands(registry, proxy) {
  registry.register("proxyhelp", "List all commands or show command usage.", (ctx) => {
    if (!ctx.args || ctx.args.length === 0) {
      const commands = ctx.registry.getAll();
      proxy.sendLog(`Available commands: ${commands.length}`);
      for (const [name, description] of commands) {
        proxy.sendLog(`\`\`${ctx.registry.prefix}${name}: ${description}`);
      }
      return;
    }

    const target = String(ctx.args[0]).toLowerCase();
    const command = ctx.registry.get(target);
    if (!command) {
      proxy.sendLog(`\`4Error: \`\`Command '${target}' not found`);
      return;
    }

    proxy.sendLog(`\`\`${ctx.registry.prefix}${target}: ${command.description}`);
  });

  registry.register("exit", "Stop proxy process.", () => {
    proxy.sendLog("Stopping proxy...");
    proxy.stop();
    setTimeout(() => process.exit(0), 100);
  });
}

module.exports = {
  registerBuiltinCommands
};
