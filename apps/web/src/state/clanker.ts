import { createClankerEnvironmentAtoms } from "@t3tools/client-runtime/state/clanker";

import { connectionAtomRuntime } from "../connection/runtime";

export const clankerEnvironment = createClankerEnvironmentAtoms(connectionAtomRuntime);
