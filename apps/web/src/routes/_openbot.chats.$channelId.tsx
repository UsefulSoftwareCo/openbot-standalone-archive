import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";
import { OpenbotChannelId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const loadChatRoute = ({ params }: { params: { channelId: string } }) => ({
  type: "chat" as const,
  channelId: Schema.decodeUnknownSync(OpenbotChannelId)(params.channelId),
});

export const Route = createFileRoute("/_openbot/chats/$channelId")({
  loader: loadChatRoute,
  component: () => <App route={Route.useLoaderData()} />,
});
