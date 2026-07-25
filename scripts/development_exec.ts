import { run } from "./process.ts";

const command = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
if (command.length === 0) {
  throw new Error("usage: deno task devcontainer:exec -- COMMAND [ARG...]");
}

await run("docker", [
  "compose",
  "exec",
  "--user",
  "vscode",
  "development",
  ...command,
]);
