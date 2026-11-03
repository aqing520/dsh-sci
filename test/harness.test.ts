import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { parseHarnessUrl, startHarness, stopHarness } from "../src/harness.js";

test("parses the authenticated official dsh web URL", () => {
  assert.equal(
    parseHarnessUrl("dsh web: http://127.0.0.1:3080/?token=abc123"),
    "http://127.0.0.1:3080/?token=abc123",
  );
});

test("ignores non-authenticated or non-loopback URLs", () => {
  assert.equal(parseHarnessUrl("dsh web: http://localhost:3080/"), undefined);
  assert.equal(parseHarnessUrl("dsh web: http://192.168.1.10:3080/?token=abc"), undefined);
});
test("harness child can bind its selected port and honors an explicit port", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const fixedPort = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const code = "const net=require('node:net');const port=Number(process.argv[process.argv.indexOf('--port')+1]);const server=net.createServer();server.on('error',()=>process.exit(1));server.listen(port,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture'));";
  for (const webPort of [undefined, 0, fixedPort]) {
    const harness = await startHarness({ home: tmpdir(), command: process.execPath, argsPrefix: ["-e", code, "--"], webPort, startupTimeoutMs: 10_000 });
    try {
      const port = Number(new URL(harness.url).port);
      assert.ok(port > 0);
      if (webPort) assert.equal(port, webPort);
      assert.equal(harness.args.at(-1), String(port));
    } finally { await stopHarness(harness.process); }
  }
});

test("parses a URL even when the harness writes the line without a trailing newline", () => {
  assert.equal(parseHarnessUrl("dsh web: http://127.0.0.1:3080/?token=abc123"), "http://127.0.0.1:3080/?token=abc123");
});
