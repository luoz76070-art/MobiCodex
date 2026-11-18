// Codex loads .codex-plugin/plugin.json. Derive it from the portable Agent Plugins manifest the same way the
// awesome-codex-plugins catalog converts portable packages, so both installs see the same metadata.
export function codexManifest(portable) {
  const { $schema, extensions = {}, skills, mcpServers, ...identity } = portable;
  const { onboardingSkill, review, publication, ...openai } = extensions['com.openai'] ?? {};
  const overlay = Object.fromEntries(Object.entries({ onboardingSkill, review, publication }).filter(([, value]) => value !== undefined));
  return { ...identity, ...openai, skills: './skills/', ...(Object.keys(overlay).length ? { extensions: { 'com.openai': overlay } } : {}) };
}
