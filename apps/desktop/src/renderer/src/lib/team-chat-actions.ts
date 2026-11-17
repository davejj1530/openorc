import { teamChat } from "./team-chat-queries";

export const sendTeamMessage = teamChat.send;
export const reactToTeamMessage = teamChat.react;
