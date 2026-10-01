export { serve } from "./wire/index.ts";
import { startProtocol } from "./wire/fleet.ts";

/** Protocol-aware entry discovered by any HTTP service's `serve --config` command. */
export const serveTarget = {
  name: "postgres", protocol: "postgres" as const, defaultPort: 0, start: startProtocol,
};
