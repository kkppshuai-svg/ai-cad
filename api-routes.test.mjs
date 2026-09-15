import test from "node:test";
import assert from "node:assert/strict";
import { createRouteTable, matchRoute } from "./api-routes.js";

const status = () => "status";
const latest = () => "latest";
const byId = () => "byId";
const chat = () => "chat";

function sampleTable() {
  return createRouteTable([
    { method: "GET", path: "/api/status", handler: status },
    { method: "POST", path: "/api/chat", handler: chat },
    { method: "GET", path: "/api/assembly/latest", handler: latest },
    { method: "GET", prefix: "/api/assembly/", handler: byId }
  ]);
}

test("an exact path matches and reports no suffix", () => {
  const match = matchRoute(sampleTable(), "GET", "/api/status");

  assert.equal(match.handler, status);
  assert.equal(match.suffix, "");
});

test("the method must match as well as the path", () => {
  assert.equal(matchRoute(sampleTable(), "POST", "/api/status"), null);
  assert.equal(matchRoute(sampleTable(), "GET", "/api/chat"), null);
});

test("the method comparison is case-insensitive", () => {
  assert.equal(matchRoute(sampleTable(), "get", "/api/status").handler, status);
  assert.equal(matchRoute(sampleTable(), "PoSt", "/api/chat").handler, chat);
});

test("a prefix match returns the remainder of the path", () => {
  const match = matchRoute(sampleTable(), "GET", "/api/assembly/asm-42");

  assert.equal(match.handler, byId);
  assert.equal(match.suffix, "asm-42");
});

test("an exact route declared before a prefix wins", () => {
  assert.equal(matchRoute(sampleTable(), "GET", "/api/assembly/latest").handler, latest);
});

test("an unknown path does not match", () => {
  assert.equal(matchRoute(sampleTable(), "GET", "/api/nope"), null);
  assert.equal(matchRoute(sampleTable(), "GET", "/api/statuses"), null);
  assert.equal(matchRoute(sampleTable(), "GET", ""), null);
});

test("a missing method or path is handled without throwing", () => {
  assert.equal(matchRoute(sampleTable(), undefined, "/api/status"), null);
  assert.equal(matchRoute(sampleTable(), "GET", undefined), null);
  assert.equal(matchRoute([], "GET", "/api/status"), null);
});

test("createRouteTable rejects malformed entries at startup", () => {
  assert.throws(() => createRouteTable([{ path: "/api/x", handler: status }]), /requires a method/);
  assert.throws(() => createRouteTable([{ method: "GET", handler: status }]), /exactly one of path or prefix/);
  assert.throws(() => createRouteTable([{ method: "GET", path: "/a", prefix: "/a/", handler: status }]), /exactly one of path or prefix/);
  assert.throws(() => createRouteTable([{ method: "GET", path: "/api/x" }]), /requires a handler/);
  assert.throws(() => createRouteTable([null]), /must be an object/);
});

test("createRouteTable normalizes the method and keeps declaration order", () => {
  const table = createRouteTable([
    { method: "get", path: "/api/a", handler: status },
    { method: "Post", prefix: "/api/b/", handler: chat }
  ]);

  assert.deepEqual(table.map((route) => route.method), ["GET", "POST"]);
  assert.equal(table[0].prefix, null);
  assert.equal(table[1].path, null);
});
