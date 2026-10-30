// Claude connector (map_*, teach_*, hub_* tools) registry (owner: MCP). The tools themselves are listed in
// worker/src/mcp/registry.js; here are the two read routes the hub's pages share with them. The shapes are at
// the top of registry/index.js.
import { overviewRoute } from '../overview.js';
import { rulesRoute } from '../rules.js';

export const ROUTES = [
  ['GET', '/api/map/overview', (...a) => overviewRoute(...a)],
  ['GET', '/api/map/rules', (...a) => rulesRoute(...a)],
];
