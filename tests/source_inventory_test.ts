// Load every application module so an untested file cannot disappear from coverage.
// Entry-point bodies are exercised separately by subprocess and container tests.
import "../apps/host/main.ts";
import "../apps/connector/mod.ts";
import "../apps/compose/main.ts";
import "../apps/compose/reconcile.ts";
import "../apps/operator/main.ts";
import "../packages/api/logger.ts";
