import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAnySearchResponse } from "./anysearch-provider.js";

test("normalizes AnySearch results array", () => {
  const result = normalizeAnySearchResponse({
    results: [{
      title: "CadQuery Workplane examples",
      url: "https://cadquery.readthedocs.io/en/latest/examples.html",
      snippet: "Examples of Workplane hole and fillet patterns.",
      score: 0.91
    }]
  }, { maxResults: 5 });

  assert.equal(result.provider, "anysearch");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].source, "cadquery.readthedocs.io");
});

test("normalizes AnySearch items array with alternate field names", () => {
  const result = normalizeAnySearchResponse({
    items: [{
      name: "GitHub CadQuery examples",
      link: "https://github.com/CadQuery/cadquery/tree/master/examples",
      description: "CadQuery example scripts"
    }]
  }, { maxResults: 5 });

  assert.equal(result.results[0].title, "GitHub CadQuery examples");
  assert.equal(result.results[0].url, "https://github.com/CadQuery/cadquery/tree/master/examples");
  assert.equal(result.results[0].snippet, "CadQuery example scripts");
});
