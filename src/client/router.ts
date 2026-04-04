// ── Hash-based SPA Router ────────────────────────────────────────────────────

export interface Route {
  pattern: RegExp;
  handler: (params: Record<string, string>) => void;
}

const routes: Route[] = [];
const listeners: Array<(path: string) => void> = [];

export function addRoute(
  path: string,
  handler: (params: Record<string, string>) => void,
): void {
  // Convert "/profile/:npub" → /^\/profile\/(?<npub>[^/]+)$/
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"
  );
  routes.push({ pattern, handler });
}

export function navigate(path: string): void {
  window.location.hash = "#" + path;
}

export function currentPath(): string {
  const hash = window.location.hash.slice(1) || "/";
  return hash;
}

export function onNavigate(fn: (path: string) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function resolve(): void {
  const path = currentPath();
  for (const fn of listeners) fn(path);

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) {
      route.handler(match.groups ?? {});
      return;
    }
  }
  // No match — default to home
  if (path !== "/") {
    navigate("/");
  }
}

// ── Initialize ───────────────────────────────────────────────────────────────

export function startRouter(): void {
  window.addEventListener("hashchange", resolve);
  resolve();
}
