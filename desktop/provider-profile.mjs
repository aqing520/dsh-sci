function yamlString(value) {
  return JSON.stringify(String(value ?? "").replace(/\r?\n/g, " "));
}

const TOKENFANS = { id: "tokenfans-codex", env: "TOKENFANS_API_KEY", name: "TokenFans Codex", baseUrl: "https://tokenfans.ai/codex", model: "gpt-6.1-sol", extraModels: ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-terra"] };

/** `native` providers are served by DSH's built-in plugins; the others are injected as OpenAI Responses routes. */
export function providerProfileIdentity(provider) {
  if (provider === "deepseek") return { id: "deepseek", env: "DEEPSEEK_API_KEY", name: "DeepSeek", native: true };
  if (provider === "tokenfans-codex") return { id: TOKENFANS.id, env: TOKENFANS.env, name: TOKENFANS.name };
  if (provider === "openai") return { id: "openai", env: "OPENAI_API_KEY", name: "OpenAI" };
  return { id: "dsh-sci-custom", env: "DSH_SCI_API_KEY", name: "dsh-sci Custom" };
}

function providerEntry(id, name, env, baseUrl, models) {
  return `      ${id}:
        displayName: ${yamlString(name)}
        apiKeyEnv: ${env}
        api: openai-responses
        baseURL: ${yamlString(baseUrl)}
        models:
${models.map((model) => `          - id: ${yamlString(model)}`).join("\n")}`;
}

/** Apply dsh-sci's marked profile sections while preserving unrelated DSH patch content. */
export function buildProviderProfilePatch(current, providerConfig, lifecyclePatchUrl, researchPatchUrl) {
  const identity = providerProfileIdentity(providerConfig.provider);
  const marker = "# dsh-sci: provider-route";
  const defaultsMarker = "# dsh-sci: provider-default";
  const searchMarker = "# dsh-sci: provider-search-disabled";
  // TokenFans is always offered as a third-party provider; only an API key is needed.
  const tokenfansSelected = identity.id === TOKENFANS.id;
  const tokenfansModels = [tokenfansSelected ? providerConfig.model : TOKENFANS.model, ...TOKENFANS.extraModels].filter((model, index, all) => all.indexOf(model) === index);
  const entries = [providerEntry(TOKENFANS.id, TOKENFANS.name, TOKENFANS.env, tokenfansSelected ? providerConfig.baseUrl : TOKENFANS.baseUrl, tokenfansModels)];
  if (!identity.native && !tokenfansSelected) entries.push(providerEntry(identity.id, identity.name, identity.env, providerConfig.baseUrl, [providerConfig.model]));
  const providerPatch = `${marker}
# Keep these routes keyless in the profile. API keys are resolved from the
# DSH credentials store (the Models settings page) or the launch environment.
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
${entries.join("\n")}
`;
  const searchBlock = `${searchMarker}\n- id: web-search-deepseek\n  disabled: true\n- id: web-deepseek-api\n  disabled: true`;
  const defaultsPatch = `${defaultsMarker}
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: agent-default-model
  config:
    provider: ${identity.id}
    model: ${yamlString(providerConfig.model)}`;
  const lifecycleBlock = `# dsh-sci: lifecycle-plugin\n- insert:\n  - id: dsh-sci-lifecycle\n    name: ${JSON.stringify(lifecyclePatchUrl)}\n# dsh-sci: lifecycle-plugin-end`;
  const researchBlock = researchPatchUrl ? `# dsh-sci: research-plugin\n- insert:\n  - id: dsh-sci-research\n    name: ${JSON.stringify(researchPatchUrl)}\n# dsh-sci: research-plugin-end` : "";
  // Legacy marker names from earlier releases are still recognised so old profiles are migrated cleanly.
  const managedBlockBoundary = "(?=\\n# dsh-sci: (?:tokenfans-search-disabled|tokenfans-default|provider-search-disabled|provider-default|lifecycle-plugin|research-plugin)|$)";
  const routePattern = new RegExp(`# dsh-sci: (?:provider-route|tokenfans-codex)\\n[\\s\\S]*?${managedBlockBoundary}`);
  const searchPattern = new RegExp(`# dsh-sci: (?:tokenfans|provider)-search-disabled\\n[\\s\\S]*?${managedBlockBoundary}`);
  const defaultsPattern = new RegExp(`# dsh-sci: (?:tokenfans|provider)-default\\n[\\s\\S]*?${managedBlockBoundary}`);
  const lifecyclePattern = /# dsh-sci: lifecycle-plugin\n[\s\S]*?(?:# dsh-sci: lifecycle-plugin-end|$)/;
  const researchPattern = /# dsh-sci: research-plugin\n[\s\S]*?(?:# dsh-sci: research-plugin-end|$)/;
  const base = current.replace(routePattern, "").replace(searchPattern, "").replace(defaultsPattern, "").replace(lifecyclePattern, "").replace(researchPattern, "").trim();
  const sections = [providerPatch.trimEnd(), ...(identity.native ? [] : [searchBlock, defaultsPatch]), lifecycleBlock, ...(researchBlock ? [researchBlock] : [])];
  return `${base ? `${base}\n\n` : ""}${sections.join("\n\n")}\n`;
}
