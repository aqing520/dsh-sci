import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function views() {
  const registrations = new Map<string, any>();
  const listeners = new Map<string, any>();
  const elements = new Map<string, any>();
  let plugin: any;
  const document = { getElementById: (id: string) => elements.get(id), addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener() {} };
  runInNewContext(await readFile(new URL("../desktop/brand/lib/client.js", import.meta.url), "utf8"), { window: { __ModuleLoader__: { load(definition: any) { plugin = definition.factory(require); } } }, document });
  plugin.apply({ theme: undefined, effect(factory: any, label: string) { if (label.includes("local evidence links")) factory(); }, slots: { inject(_name: string, factory: any) { const value = factory(); if (value?.next) Array.from(value); }, register(spec: any, component: any) { registrations.set(spec.key ?? spec.name, component); return () => {}; } } });
  const render = (name: string, value: any, isError = false) => renderToStaticMarkup(React.createElement(registrations.get(name), { toolName: name, phase: "result", block: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError } }));
  return { render, listeners, elements, registrations };
}

test("research cards replay saved passages, exact quotes, links and run identity in the conversation", async () => {
  const { render, registrations } = await views();
  assert.equal([...registrations.keys()].filter((key) => key.startsWith("research_")).length, 21);
  const read = render("research_read", { content: { sourceId: "source-a", contentVersionId: "content-a", contentHash: "abc", scope: "full-text" }, chunks: [{ chunkId: "chunk-a", text: "<script>untrusted source text</script>" }], nextOffset: 1 });
  assert.match(read, /id="dsh-sci-evidence-chunk-a"/);
  assert.match(read, /&lt;script&gt;untrusted source text/);
  assert.doesNotMatch(read, /<script>/);
  assert.match(read, /不等于读完整篇/);
  assert.match(read, /下一片段偏移：1/);
  const cite = render("research_cite", { citationId: "citation-a", sourceId: "source-a", contentVersionId: "content-a", locator: { chunkId: "chunk-a" }, quotedText: "paired observations", verification: { status: "verbatim-match" } });
  assert.match(cite, /id="dsh-sci-evidence-citation-a"/);
  assert.match(cite, /href="#dsh-sci-evidence-chunk-a"/);
  assert.match(cite, /支持关系仍需判断/);
  assert.match(render("research_claim", { claimId: "claim-a", text: "A limited comparison", citationIds: ["citation-a"] }), /href="#dsh-sci-evidence-citation-a"/);
  assert.match(render("research_execute", { reused: true, run: { runId: "run-a", state: "completed", stdout: "6", manifest: { command: "node", inputFiles: [] } } }), /复用已有结果，未重跑/);
  assert.match(render("research_checkpoint", { checkpoint: { summary: "Unresolved competing explanation." } }), /不等于科学结论验收/);
  assert.match(render("research_read", "File was not found", true), /失败/);
});

test("evidence links reveal only existing rendered records without invoking any service", async () => {
  const { listeners, elements } = await views();
  let prevented = 0, scrolled = 0;
  const disclosure = { tagName: "DETAILS", open: false, parentElement: null };
  elements.set("dsh-sci-evidence-citation-a", { tagName: "SECTION", parentElement: disclosure, scrollIntoView() { scrolled++; }, focus() {} });
  const click = (href: string) => listeners.get("click")({ target: { closest: () => ({ getAttribute: () => href }) }, preventDefault() { prevented++; }, stopPropagation() {} });
  click("#dsh-sci-evidence-citation-a");
  assert.equal(disclosure.open, true);
  assert.equal(scrolled, 1);
  click("#dsh-sci-evidence-absent-record");
  click("https://untrusted.example/#dsh-sci-evidence-citation-a");
  assert.equal(prevented, 1);
});
