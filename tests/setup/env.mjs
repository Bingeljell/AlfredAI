// Test hermeticity — loaded via `node --import` before any test module.
//
// The developer's real .env often contains an auto-generated ALFRED_API_KEY.
// config/env.ts runs dotenv on import, which would otherwise make the gateway's
// auth middleware require that key and 401 every unauthenticated test request.
//
// Setting the var (even to empty) *before* dotenv loads keeps dotenv from
// repopulating it (dotenv defaults to override: false), so the middleware sees
// no key and runs open. Tests that need to exercise auth can set it explicitly.
process.env.ALFRED_API_KEY = "";

// Same reasoning for the agent-event webhook: give tests a deterministic shared
// secret so the /api/events/agent auth path is exercised (loopback-only mode is
// covered by unit tests of src/agentEvents/auth.ts).
process.env.ALFRED_AGENT_EVENT_TOKEN = "test-agent-event-token";
