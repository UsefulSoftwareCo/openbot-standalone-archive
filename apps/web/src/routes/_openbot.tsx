import { createFileRoute, notFound, Outlet, redirect } from "@tanstack/react-router";
import { isOpenbot } from "../product";

export const Route = createFileRoute("/_openbot")({
  beforeLoad: ({ context }) => {
    if (!isOpenbot) throw notFound();
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: Outlet,
});
