export function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function isAllowedHostHeader(value, { host = "127.0.0.1", port } = {}) {
  const actual = normalizeHost(value);
  if (!actual) return false;
  const expectedHosts = new Set([
    normalizeHost(host),
    "127.0.0.1",
    "localhost",
    "[::1]"
  ]);
  const allowed = new Set();
  for (const item of expectedHosts) {
    if (!item) continue;
    allowed.add(item);
    if (port) allowed.add(`${item}:${port}`);
  }
  return allowed.has(actual);
}

export function isAllowedOriginHeader(value, { host = "127.0.0.1", port } = {}) {
  if (!value) return true;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  return isAllowedHostHeader(parsed.host, { host, port });
}

export function isStateChangingMethod(method) {
  return String(method || "").toUpperCase() === "POST";
}

export function isValidRequestToken(value, expected) {
  return Boolean(expected && value && String(value) === String(expected));
}
