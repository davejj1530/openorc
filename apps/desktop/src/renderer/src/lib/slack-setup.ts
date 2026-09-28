/** Public setup data only; this URL and manifest must never contain tokens. */
export function slackPersonalManifest(name = "OpenOrc Personal") {
  const displayName = name.trim().slice(0, 35) || "OpenOrc Personal";
  return {
    display_information: { name: displayName, description: "Your personal OpenOrc desktop assistant" },
    features: {
      bot_user: { display_name: displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "openorc-personal", always_online: false },
      // Native Markdown replies use Slack's AI app features. New apps use agent_view.
      agent_view: { agent_description: "Mention this personal bot in a channel to work with your OpenOrc desktop. Continue in that channel thread." },
    },
    oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write", "channels:history", "groups:history", "users:read", "files:read"] } },
    settings: {
      socket_mode_enabled: true,
      interactivity: { is_enabled: true },
      event_subscriptions: { bot_events: ["app_mention", "message.channels", "message.groups"] },
    },
  };
}
export function slackPersonalCreateUrl(name: string) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackPersonalManifest(name)))}`;
}
