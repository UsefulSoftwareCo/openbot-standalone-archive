import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";

export const Route = createFileRoute("/_openbot/chats/new")({
  component: () => <App route={{ type: "new-chat" }} />,
});
