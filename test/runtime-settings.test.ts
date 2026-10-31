import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRuntimeSettings, loadRuntimeSettings, runtimeSettingsToEnvironment, saveRuntimeSettings, updateRuntimeSettings } from "../src/runtime-settings.js";

test("runtime settings validate non-sensitive provider and service fields", () => {
  const settings = updateRuntimeSettings(defaultRuntimeSettings(), { provider: { provider: "openai", baseUrl: "https://api.example.test/v1/?token=hidden", model: "model-x", timeoutMs: 5000 }, service: { provider: "research", baseUrl: "https://service.example.test/api?key=hidden", timeoutMs: 6000, retries: 3 } });
  assert.deepEqual(settings.provider, { provider: "openai", baseUrl: "https://api.example.test/v1", model: "model-x", timeoutMs: 5000 });
  assert.deepEqual(settings.service, { provider: "research", baseUrl: "https://service.example.test/api", timeoutMs: 6000, retries: 3 });
  assert.deepEqual(runtimeSettingsToEnvironment(settings), { DSH_SCI_PROVIDER: "openai", DSH_SCI_BASE_URL: "https://api.example.test/v1", DSH_SCI_MODEL: "model-x", DSH_SCI_PROVIDER_TIMEOUT_MS: "5000", DSH_SCI_SERVICE_PROVIDER: "research", DSH_SCI_SERVICE_BASE_URL: "https://service.example.test/api", DSH_SCI_SERVICE_TIMEOUT_MS: "6000", DSH_SCI_SERVICE_RETRIES: "3" });
  assert.throws(() => updateRuntimeSettings(defaultRuntimeSettings(), { provider: { baseUrl: "https://user:pass@example.test" } }), /without embedded credentials/);
  assert.throws(() => updateRuntimeSettings(defaultRuntimeSettings(), { service: { retries: 6 } }), /between 0 and 5/);
});

test("runtime settings save atomically and never accepts api keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-runtime-settings-"));
  const file = path.join(root, "runtime-settings.json");
  try {
    const settings = updateRuntimeSettings(defaultRuntimeSettings(), { provider: { provider: "custom", model: "local" } });
    await saveRuntimeSettings(file, settings);
    const loaded = await loadRuntimeSettings(file);
    assert.deepEqual(loaded, settings);
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /apiKey|API_KEY|secret/iu);
    assert.deepEqual(await loadRuntimeSettings(path.join(root, "missing.json")), defaultRuntimeSettings());
  } finally { await rm(root, { recursive: true, force: true }); }
});
