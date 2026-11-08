import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Lib = createRequire(import.meta.url)("../src/lib.js");

const call = (over) => ({
  id: Math.random().toString(36).slice(2), ts: 1000, method: "GET",
  url: "https://api.example.com/widgets", status: 200,
  requestHeaders: {}, requestBody: null, responseBody: null, ...over,
});

test("templateUrl: numeric ids, uuids and hashes become params", () => {
  const t1 = Lib.lensTemplateUrl("https://api.example.com/users/42/orders/7");
  assert.equal(t1.template, "/users/{id}/orders/{id_2}");
  assert.deepEqual(t1.params.map((p) => p.name), ["id", "id_2"]);
  const t2 = Lib.lensTemplateUrl("https://api.example.com/files/9f1c2b3e-1111-4222-8333-abcdefabcdef");
  assert.equal(t2.template, "/files/{uuid}");
  const t3 = Lib.lensTemplateUrl("https://api.example.com/about/team");
  assert.equal(t3.template, "/about/team");
});

test("groupEndpoints merges calls into templated endpoints with schemas", () => {
  const eps = Lib.lensGroupEndpoints([
    call({ url: "https://api.example.com/users/1?verbose=true", responseBody: { id: 1, name: "A" } }),
    call({ url: "https://api.example.com/users/2", responseBody: { id: 2, name: "B", extra: true } }),
    call({ method: "POST", url: "https://api.example.com/users", status: 201, requestBody: { name: "C", password: "x" }, requestHeaders: { Authorization: "Bearer abc" } }),
  ]);
  assert.equal(eps.length, 2);
  const get = eps.find((e) => e.method === "GET");
  assert.equal(get.template, "/users/{id}");
  assert.equal(get.callCount, 2);
  assert.equal(get.responseSchema.properties.name.type, "string");
  assert.equal(get.responseSchema.required.includes("id"), true);
  assert.equal(get.responseSchema.required.includes("extra"), false);
  const post = eps.find((e) => e.method === "POST");
  assert.deepEqual(post.auth, { type: "bearer", header: "Authorization" });
});

test("redaction strips secrets from headers and bodies, keeps shapes", () => {
  const h = Lib.lensRedactHeaders({ Authorization: "Bearer abc", "Content-Type": "application/json" });
  assert.equal(h.Authorization, "•••redacted•••");
  assert.equal(h["Content-Type"], "application/json");
  const b = Lib.lensRedactBody({ user: "kevin", password: "hunter2", nested: { api_key: "k" } });
  assert.equal(b.user, "kevin");
  assert.equal(b.password, "•••redacted•••");
  assert.equal(b.nested.api_key, "•••redacted•••");
});

test("endpoints -> OpenAPI -> callable tools through the existing importer", () => {
  const eps = Lib.lensGroupEndpoints([
    call({ url: "https://api.example.com/users/9", responseBody: { id: 9 } }),
    call({ method: "DELETE", url: "https://api.example.com/users/9", status: 204 }),
  ]);
  const spec = Lib.lensEndpointsToOpenApi(eps, "Test capture");
  assert.equal(spec.servers[0].url, "https://api.example.com");
  const tools = Lib.toolsFromOpenApi(spec);
  assert.equal(tools.length, 2);
  const get = tools.find((t) => t.action.method === "GET");
  const del = tools.find((t) => t.action.method === "DELETE");
  assert.equal(get.risk, "read");
  assert.equal(del.risk, "write");
  assert.equal(get.action.path, "/users/{id}");
  assert.ok(get.inputSchema.properties.id);
});
