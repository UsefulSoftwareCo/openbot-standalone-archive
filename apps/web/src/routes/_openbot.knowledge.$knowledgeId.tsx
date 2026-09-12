import { createFileRoute } from "@tanstack/react-router";
import { App } from "../../../openbot/src/App";
import { OpenbotKnowledgeId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const loadKnowledgeRoute = ({ params }: { params: { knowledgeId: string } }) => ({
  type: "knowledge" as const,
  projectId: null,
  knowledgeId:
    params.knowledgeId === "new"
      ? null
      : Schema.decodeUnknownSync(OpenbotKnowledgeId)(params.knowledgeId),
});

export const Route = createFileRoute("/_openbot/knowledge/$knowledgeId")({
  loader: loadKnowledgeRoute,
  component: () => <App route={Route.useLoaderData()} />,
});
