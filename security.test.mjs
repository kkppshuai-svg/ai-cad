import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedHostHeader,
  isAllowedOriginHeader,
  isStateChangingMethod,
  isValidRequestToken,
} from "./security.js";

test("allows only loopback host headers for the local server", () => {
  assert.equal(isAllowedHostHeader("127.0.0.1:3101", { host: "127.0.0.1", port: 3101 }), true);
  assert.equal(isAllowedHostHeader("localhost:3101", { host: "127.0.0.1", port: 3101 }), true);
  assert.equal(isAllowedHostHeader("evil.example", { host: "127.0.0.1", port: 3101 }), false);
});

test("rejects cross-site origins for state-changing browser requests", () => {
  assert.equal(isAllowedOriginHeader("", { host: "127.0.0.1", port: 3101 }), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:3101", { host: "127.0.0.1", port: 3101 }), true);
  assert.equal(isAllowedOriginHeader("http://localhost:3101", { host: "127.0.0.1", port: 3101 }), true);
  assert.equal(isAllowedOriginHeader("http://evil.example", { host: "127.0.0.1", port: 3101 }), false);
});

test("requires an exact token for POST requests", () => {
  assert.equal(isStateChangingMethod("GET"), false);
  assert.equal(isStateChangingMethod("POST"), true);
  assert.equal(isValidRequestToken("secret", "secret"), true);
  assert.equal(isValidRequestToken("", "secret"), false);
  assert.equal(isValidRequestToken("wrong", "secret"), false);
});
