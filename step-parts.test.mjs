import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  StepPartsError,
  buildStepPartsSearchUrl,
  resolveAndDownloadStepPart,
} from "./step-parts.js";

test("builds step.parts search URLs with query and facets", () => {
  const url = buildStepPartsSearchUrl({
    origin: "https://api.step.parts",
    query: "608ZZ bearing",
    category: "bearing",
    tag: "608zz",
  });

  assert.equal(
    url,
    "https://api.step.parts/v1/parts?page=1&pageSize=5&q=608ZZ+bearing&category=bearing&tag=608zz",
  );
});

test("downloads the first matching part and verifies sha256", async () => {
  const stepBytes = Buffer.from("ISO-10303-21; mock step");
  const sha256 = createHash("sha256").update(stepBytes).digest("hex");
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes("/v1/parts?")) {
      return {
        json: async () => ({
          total: 1,
          items: [{
            id: "bearing_608zz",
            name: "608ZZ bearing",
            downloadUrl: "https://api.step.parts/v1/parts/bearing_608zz/download",
            apiUrl: "https://api.step.parts/v1/parts/bearing_608zz",
            pageUrl: "https://www.step.parts/parts/bearing_608zz",
            sha256,
          }],
        }),
      };
    }
    return { arrayBuffer: async () => stepBytes };
  };

  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  const result = await resolveAndDownloadStepPart({
    request: { query: "608ZZ bearing" },
    cacheDir,
    httpRequest: request,
  });

  assert.equal(result.id, "bearing_608zz");
  assert.equal(result.checksumVerified, true);
  assert.equal(await readFile(result.localStepPath, "utf8"), stepBytes.toString());
  assert.equal(calls.length, 2);
});

test("uses exact id fetch when provided", async () => {
  const stepBytes = Buffer.from("ISO-10303-21; exact step");
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.endsWith("/v1/parts/iso4762_m3x12")) {
      return {
        json: async () => ({
          id: "iso4762_m3x12",
          name: "M3x12 socket head cap screw",
          downloadUrl: "https://api.step.parts/v1/parts/iso4762_m3x12/download",
        }),
      };
    }
    return { arrayBuffer: async () => stepBytes };
  };

  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  const result = await resolveAndDownloadStepPart({
    request: { id: "iso4762_m3x12", query: "M3 x 12 screw" },
    cacheDir,
    httpRequest: request,
  });

  assert.equal(result.id, "iso4762_m3x12");
  assert.equal(calls[0], "https://api.step.parts/v1/parts/iso4762_m3x12");
});

test("throws a clear no-match error", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  await assert.rejects(
    () => resolveAndDownloadStepPart({
      request: { query: "missing servo" },
      cacheDir,
      httpRequest: async () => ({ json: async () => ({ total: 0, items: [] }) }),
    }),
    (error) => error instanceof StepPartsError && /No step\.parts result matched/.test(error.message),
  );
});

test("throws a clear checksum mismatch error", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  await assert.rejects(
    () => resolveAndDownloadStepPart({
      request: { query: "bad checksum" },
      cacheDir,
      httpRequest: async (url) => url.includes("/v1/parts?")
        ? { json: async () => ({ items: [{ id: "bad", name: "bad", downloadUrl: "https://api.step.parts/v1/parts/bad/download", sha256: "deadbeef" }] }) }
        : { arrayBuffer: async () => Buffer.from("wrong") },
    }),
    (error) => error instanceof StepPartsError && /checksum/i.test(error.message),
  );
});
