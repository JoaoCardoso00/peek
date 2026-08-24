const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken || !guildId) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_ID before running this script.");
  process.exitCode = 1;
} else {
  const commands = [
    {
      name: "share",
      description: "Create a Peek room and start sharing your screen",
      type: 1
    }
  ];
  const base = `https://discord.com/api/v10/applications/${applicationId}`;
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
    console.error(`Could not register /share: ${response.status} ${await response.text()}`);
    process.exitCode = 1;
  } else {
    console.log(`Registered /share in guild ${guildId}.`);
  }

  const permissions = 1024 + 2048 + 16384;
  const invite = new URL("https://discord.com/oauth2/authorize");
  invite.searchParams.set("client_id", applicationId);
  invite.searchParams.set("scope", "bot applications.commands");
  invite.searchParams.set("permissions", String(permissions));
  console.log(`Install URL: ${invite}`);
}
