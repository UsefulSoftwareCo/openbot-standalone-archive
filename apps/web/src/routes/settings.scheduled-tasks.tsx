import { createFileRoute, redirect } from "@tanstack/react-router";

import { isOpenbot } from "../product";
import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";

export const Route = createFileRoute("/settings/scheduled-tasks")({
  beforeLoad: () => {
    if (isOpenbot) throw redirect({ to: "/settings/general", replace: true });
  },
  component: ScheduledTasksSettings,
});
