# Traceability Matrix

| Evidence | Code Module | Test |
|---|---|---|
| package.json contributes | `package.json`, `src/extension.ts` | `tests/integration/extension.integration.test.ts` |
| `/events` `/message` `/sse` strings | `src/core/bridge.ts` | `tests/e2e/bridge.e2e.test.ts` |
| `configureMcpConfig` | `src/adapters/mcp-config.ts` | `tests/unit/mcp-config.test.ts` |
| `configureGlobalRules` | `src/adapters/rules.ts` | `tests/unit/rules.test.ts` |
| `mammoth/xlsx` deps | `src/adapters/importers.ts` | `tests/unit/importers.test.ts` |
