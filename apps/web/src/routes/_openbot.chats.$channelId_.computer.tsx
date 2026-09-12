import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";
import { OpenbotChannelId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const loadComputerRoute = ({ params }: { params: { channelId: string } }) => ({
  type: "computer" as const,
  channelId: Schema.decodeUnknownSync(OpenbotChannelId)(params.channelId),
});

export const Route = createFileRoute("/_openbot/chats/$channelId_/computer")({
  loader: loadComputerRoute,
  component: () => <App route={Route.useLoaderData()} />,
});
