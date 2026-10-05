import { serveCompose } from "./controller.ts";
import { validateProject } from "./docker.ts";
import { ValidationError } from "../../packages/api/mod.ts";

export async function main(
  args: string[] = Deno.args,
  serve: typeof serveCompose = serveCompose,
): Promise<void> {
  if (args.length) throw new ValidationError("Compose controller accepts no arguments");
  const project = Deno.env.get("BUNNY_HOLE_COMPOSE_PROJECT") ?? "";
  validateProject(project);
  const configPath = Deno.env.get("BUNNY_HOLE_CONFIG") ?? "/config/config.json";
  if (!configPath) {
    throw new ValidationError("Compose controller requires a config path");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    await serve(project, configPath, controller.signal);
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error("Compose controller startup failed");
    Deno.exitCode = 1;
  });
}
