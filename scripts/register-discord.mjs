const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildIds = [process.env.DISCORD_GUILD_ID, ...(process.env.DISCORD_GUILD_IDS ?? "").split(/[\s,]+/)]
  .map((guildId) => guildId?.trim())
  .filter(Boolean)
  .filter((guildId, index, all) => all.indexOf(guildId) === index);

if (!applicationId || !botToken || guildIds.length === 0) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_IDS before running this script.");
  process.exitCode = 1;
} else {
  const permissions = 1024 + 2048 + 16384;
  const invite = new URL("https://discord.com/oauth2/authorize");
  invite.searchParams.set("client_id", applicationId);
  invite.searchParams.set("scope", "bot applications.commands");
  invite.searchParams.set("permissions", String(permissions));
  console.log(`Install URL: ${invite}`);

  const commands = [
    {
      name: "share",
      description: "Create a Peek room and start sharing your screen",
      type: 1
    }
  ];
  const base = `https://discord.com/api/v10/applications/${applicationId}`;
  for (const guildId of guildIds) {
    const endpoint = `${base}/guilds/${guildId}/commands`;
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commands)
    });
    if (!response.ok) {
      console.error(`Could not register /share in guild ${guildId}: ${response.status} ${await response.text()}`);
      process.exitCode = 1;
    } else {
      console.log(`Registered /share in guild ${guildId}.`);
    }
  }

}
