function yamlString(value) {
  return JSON.stringify(String(value ?? "").replace(/\r?\n/g, " "));
}

export function providerProfileIdentity(provider) {
  if (provider === "tokenfans-codex") return { id: "tokenfans-codex", env: "TOKENFANS_API_KEY", name: "TokenFans Codex" };
  if (provider === "openai") return { id: "openai", env: "OPENAI_API_KEY", name: "OpenAI" };
  return { id: "dsh-sci-custom", env: "DSH_SCI_API_KEY", name: "dsh-sci Custom" };
}

/** Apply dsh-sci's marked profile sections while preserving unrelated DSH patch content. */
export function buildProviderProfilePatch(current, providerConfig, lifecyclePatchUrl, researchPatchUrl) {
  const identity = providerProfileIdentity(providerConfig.provider);
  const marker = "# dsh-sci: provider-route";
  const defaultsMarker = "# dsh-sci: tokenfans-default";
  const providerPatch = `${marker}
# Keep this route keyless in the profile. The API key is resolved by the
# provider environment supplied by the desktop host.
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ${identity.id}:
        displayName: ${yamlString(identity.name)}
        apiKeyEnv: ${identity.env}
        api: openai-responses
        baseURL: ${yamlString(providerConfig.baseUrl)}
        models:
          - id: ${yamlString(providerConfig.model)}
`;
  const searchBlock = "# dsh-sci: tokenfans-search-disabled\n- id: web-search-deepseek\n  disabled: true\n- id: web-deepseek-api\n  disabled: true";
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
  const managedBlockBoundary = "(?=\\n# dsh-sci: (?:tokenfans-search-disabled|tokenfans-default|lifecycle-plugin|research-plugin)|$)";
  const routePattern = new RegExp(`# dsh-sci: (?:provider-route|tokenfans-codex)\\n[\\s\\S]*?${managedBlockBoundary}`);
  const searchPattern = new RegExp(`# dsh-sci: tokenfans-search-disabled\\n[\\s\\S]*?${managedBlockBoundary}`);
  const defaultsPattern = new RegExp(`# dsh-sci: tokenfans-default\\n[\\s\\S]*?${managedBlockBoundary}`);
  const lifecyclePattern = /# dsh-sci: lifecycle-plugin\n[\s\S]*?(?:# dsh-sci: lifecycle-plugin-end|$)/;
  const researchPattern = /# dsh-sci: research-plugin\n[\s\S]*?(?:# dsh-sci: research-plugin-end|$)/;
  const base = current.replace(routePattern, "").replace(searchPattern, "").replace(defaultsPattern, "").replace(lifecyclePattern, "").replace(researchPattern, "").trim();
  return `${base ? `${base}\n\n` : ""}${providerPatch.trimEnd()}\n\n${searchBlock}\n\n${defaultsPatch}\n\n${lifecycleBlock}${researchBlock ? `\n\n${researchBlock}` : ""}\n`;
}
