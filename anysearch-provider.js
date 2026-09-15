export function normalizeAnySearchResponse(payload, options = {}) {
  const maxResults = Math.max(1, Math.min(8, Number(options.maxResults || 5)));
  const rawItems = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  return {
    provider: "anysearch",
    results: dedupeSearchResults(rawItems.map(normalizeAnySearchItem).filter(Boolean)).slice(0, maxResults)
  };
}

function normalizeAnySearchItem(item) {
  const url = String(item.url || item.link || item.href || "").trim();
  const title = String(item.title || item.name || item.heading || "").replace(/\s+/g, " ").trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return {
    title: title.slice(0, 180),
    url,
    source: String(item.source || item.site || hostnameOf(url) || "").slice(0, 120),
    snippet: String(item.snippet || item.description || item.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null
  };
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = result.url.replace(/[?#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}
