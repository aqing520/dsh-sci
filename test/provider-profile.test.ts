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
  assert.match(first, /# dsh-sci: provider-search-disabled/);
});

test("provider profile patch installs research plugin idempotently", () => {
  const config = { provider: "custom", baseUrl: "http://127.0.0.1:8080/v1", model: "model-x" };
  const first = buildProviderProfilePatch("# upstream: keep\n", config, "file:///tmp/lifecycle.mjs", "file:///tmp/research.mjs");
  const second = buildProviderProfilePatch(first, config, "file:///tmp/lifecycle.mjs", "file:///tmp/research.mjs");
  assert.equal(second, first);
  assert.equal((first.match(/# dsh-sci: research-plugin-end/g) ?? []).length, 1);
  assert.match(first, /id: dsh-sci-research/);
});

test("default DeepSeek profile keeps the native route and offers TokenFans as a keyed third-party provider", () => {
  const config = { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };
  const legacy = "# dsh-sci: tokenfans-default\n- id: llm-deepseek\n  disabled: true\n";
  const first = buildProviderProfilePatch(legacy, config, "file:///tmp/lifecycle.mjs");
  assert.equal(buildProviderProfilePatch(first, config, "file:///tmp/lifecycle.mjs"), first);
  assert.match(first, /tokenfans-codex:/);
  assert.match(first, /apiKeyEnv: TOKENFANS_API_KEY/);
  assert.doesNotMatch(first, /llm-deepseek/);
  assert.doesNotMatch(first, /agent-default-model/);
});

test("provider profile patch replaces the official brand with the dsh-sci brand idempotently", () => {
  const config = { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };
  const args = [config, "file:///tmp/lifecycle.mjs", "file:///tmp/research.mjs", "file:///tmp/brand/lib/index.js"] as const;
  const first = buildProviderProfilePatch("", ...args);
  assert.equal(buildProviderProfilePatch(first, ...args), first);
  assert.match(first, /- id: ui-brand-official\r?\n  disabled: true/);
  assert.match(first, /id: dsh-sci-brand/);
  assert.equal((first.match(/# dsh-sci: brand-plugin-end/g) ?? []).length, 1);
});
