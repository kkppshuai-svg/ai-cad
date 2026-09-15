/**
 * Minimal API route table.
 *
 * Routes are matched in declaration order, so a more specific exact path must
 * be declared before a prefix that would also swallow it — e.g.
 * `/api/assembly/latest` before the `/api/assembly/` prefix. createRouteTable()
 * validates the shape up front so a typo fails at startup rather than as a
 * silent 404 at request time.
 */

function assertRoute(route, index) {
  if (!route || typeof route !== "object") throw new TypeError(`Route ${index} must be an object`);
  if (typeof route.method !== "string" || !route.method) throw new TypeError(`Route ${index} requires a method`);
  const hasPath = Boolean(typeof route.path === "string" && route.path);
  const hasPrefix = Boolean(typeof route.prefix === "string" && route.prefix);
  if (hasPath === hasPrefix) throw new TypeError(`Route ${index} requires exactly one of path or prefix`);
  if (typeof route.handler !== "function") throw new TypeError(`Route ${index} (${route.path || route.prefix}) requires a handler`);
  return {
    method: route.method.toUpperCase(),
    path: hasPath ? route.path : null,
    prefix: hasPrefix ? route.prefix : null,
    handler: route.handler
  };
}

export function createRouteTable(routes = []) {
  return routes.map(assertRoute);
}

/**
 * Resolve a request to a route.  Returns `{ handler, suffix }`, where `suffix`
 * is the part of the path after a prefix match (empty string for exact
 * matches), or null when nothing matches.
 */
export function matchRoute(table, method, pathname) {
  const wanted = String(method || "").toUpperCase();
  const target = String(pathname || "");
  for (const route of table) {
    if (route.method !== wanted) continue;
    if (route.path) {
      if (route.path === target) return { handler: route.handler, suffix: "" };
      continue;
    }
    if (target.startsWith(route.prefix)) {
      return { handler: route.handler, suffix: target.slice(route.prefix.length) };
    }
  }
  return null;
}
