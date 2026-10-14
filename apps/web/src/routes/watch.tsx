import { createFileRoute, redirect } from "@tanstack/react-router";

import { WatchScreen } from "../components/watch/WatchScreen";

export const Route = createFileRoute("/watch")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WatchScreen,
});
