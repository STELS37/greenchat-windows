import test from "node:test";
import assert from "node:assert/strict";

import { ApiClient } from "../src/api.ts";

const tokens = () => ({ access: null, refresh: null, accessExpiresAt: null });

test("ApiClient.resolveUrl binds root-relative media to the configured API origin", () => {
  const api = new ApiClient({
    baseUrl: "https://api.greenchat.example/",
    clientId: "android/1.0.0",
    tokens: tokens(),
  });

  assert.equal(api.resolveUrl("/f/17?e=1&u=2&s=x"), "https://api.greenchat.example/f/17?e=1&u=2&s=x");
  assert.equal(api.resolveUrl("f/18"), "https://api.greenchat.example/f/18");
});

test("ApiClient.resolveUrl leaves complete URLs and same-origin web paths unchanged", () => {
  const native = new ApiClient({ baseUrl: "https://api.greenchat.example", clientId: "desktop/1", tokens: tokens() });
  assert.equal(native.resolveUrl("https://cdn.example/avatar.webp"), "https://cdn.example/avatar.webp");
  assert.equal(native.resolveUrl("blob:https://app.example/id"), "blob:https://app.example/id");
  assert.equal(native.resolveUrl("data:image/png;base64,AA=="), "data:image/png;base64,AA==");

  const web = new ApiClient({ baseUrl: "", clientId: "web/1", tokens: tokens() });
  assert.equal(web.resolveUrl("/f/19?x=1"), "/f/19?x=1");
});
