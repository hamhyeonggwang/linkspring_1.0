import assert from "node:assert/strict";
import test from "node:test";

// Run against an explicitly started loopback development server.
const base = process.env.LINKSPRING_TEST_URL || "http://127.0.0.1:5173";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname));

test("renders Korean application shell and product metadata", async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/i);
  const html = await response.text();
  assert.match(html, /이어:봄 LinkSpring/);
  assert.match(html, /lang="ko"/);
  assert.match(html, /코디네이터 업무/);
});

test("HTTP API rejects cross-origin mutations and unfiltered AI text", async () => {
  for (const path of ["/api/state", "/api/ai/parse-absence"]) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
  }
  const response = await fetch(base + "/api/ai/parse-absence", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(base).origin,
    },
    body: JSON.stringify({ text: "가상이름 010-0000-0000 내일 09:00" }),
  });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /가상이름|010-0000-0000/);
});
