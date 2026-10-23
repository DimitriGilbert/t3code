import { createWatchEnvironmentAtoms } from "@t3tools/client-runtime/state/watch";

import { connectionAtomRuntime } from "../connection/runtime";

export const watchEnvironment = createWatchEnvironmentAtoms(connectionAtomRuntime);
