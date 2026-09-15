export function createApiClient({ fetchImpl = fetch, getToken, setToken }) {
  async function request(url, options = {}, allowTokenRefresh = true) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    const token = getToken?.() || "";
    if (method === "POST" && token) headers["X-AI-CAD-Token"] = token;

    const init = { ...options, headers };
    if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
    const response = await fetchImpl(url, init);
    const data = await readJson(response);

    if (response.ok) return data;
    if (allowTokenRefresh && method === "POST" && response.status === 403 && data.error === "Invalid request token") {
      const statusResponse = await fetchImpl("/api/status", { headers: { "Content-Type": "application/json" } });
      const status = await readJson(statusResponse);
      if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
      if (!status.requestToken) throw new Error(data.error);
      setToken?.(status.requestToken);
      return request(url, options, false);
    }
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code || null;
    error.details = data;
    throw error;
  }

  return request;
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
