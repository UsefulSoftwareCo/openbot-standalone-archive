import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";
import { OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const loadProjectKnowledgeRoute = ({
  params,
}: {
  params: { projectId: string; knowledgeId: string };
}) => ({
  type: "knowledge" as const,
  projectId: Schema.decodeUnknownSync(OpenbotProjectId)(params.projectId),
  knowledgeId:
    params.knowledgeId === "new"
      ? null
      : Schema.decodeUnknownSync(OpenbotKnowledgeId)(params.knowledgeId),
});

export const Route = createFileRoute("/_openbot/projects/$projectId/knowledge/$knowledgeId")({
  loader: loadProjectKnowledgeRoute,
  component: () => <App route={Route.useLoaderData()} />,
});
