import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";
import { OpenbotProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const loadProjectSettingsRoute = ({
  params,
}: {
  params: { projectId: string; tab: string };
}) => ({
  type: "project-settings" as const,
  projectId: Schema.decodeUnknownSync(OpenbotProjectId)(params.projectId),
  tab: Schema.decodeUnknownSync(Schema.Literals(["knowledge", "instructions"]))(params.tab),
});

export const Route = createFileRoute("/_openbot/projects/$projectId/settings/$tab")({
  loader: loadProjectSettingsRoute,
  component: () => <App route={Route.useLoaderData()} />,
});
