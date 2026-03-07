export const LEAD_DOMAIN_PROMPT_VERSION = "2026-03-07.leads.v1";

export const LEAD_GENERATION_DOMAIN_SYSTEM_PROMPT = `
Domain: B2B lead generation.

Quality principles:
- Prefer real company entities over generic articles.
- Treat retrieval failures and semantic misses as first-class signals.
- Bias toward actionable outputs (company, source, contact data, evidence).
- Keep extraction grounded in observed page content.
- Optimize for objective completion under budget/time constraints.
`.trim();
