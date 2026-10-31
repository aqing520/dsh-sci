import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error the profile helper is intentionally plain ESM JavaScript.
import { buildProviderProfilePatch } from "../desktop/provider-profile.mjs";

test("provider profile patch is repeatable and preserves unrelated DSH content", () => {
  const config = { provider: "custom", baseUrl: "http://127.0.0.1:8080/v1\"quoted", model: "model\nwith-newline" };
  const first = buildProviderProfilePatch("# upstream: keep\n", config, "file:///tmp/lifecycle.mjs");
  const second = buildProviderProfilePatch(first, config, "file:///tmp/lifecycle.mjs");
  assert.equal(second, first);
  assert.match(first, /# upstream: keep/);
  assert.match(first, /baseURL: "http:\/\/127\.0\.0\.1:8080\/v1\\\"quoted"/);
  assert.match(first, /model: "model with-newline"/);
  assert.equal((first.match(/# dsh-sci: lifecycle-plugin-end/g) ?? []).length, 1);
  assert.equal((first.match(/# dsh-sci: provider-route/g) ?? []).length, 1);
  assert.match(first, /# dsh-sci: tokenfans-search-disabled/);
});

test("provider profile patch installs research plugin idempotently", () => {
  const config = { provider: "custom", baseUrl: "http://127.0.0.1:8080/v1", model: "model-x" };
  const first = buildProviderProfilePatch("# upstream: keep\n", config, "file:///tmp/lifecycle.mjs", "file:///tmp/research.mjs");
  const second = buildProviderProfilePatch(first, config, "file:///tmp/lifecycle.mjs", "file:///tmp/research.mjs");
  assert.equal(second, first);
  assert.equal((first.match(/# dsh-sci: research-plugin-end/g) ?? []).length, 1);
  assert.match(first, /id: dsh-sci-research/);
});
