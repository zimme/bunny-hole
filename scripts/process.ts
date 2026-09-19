export async function run(
  command: string,
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<void> {
  const child = new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...options,
  });
  const status = await child.spawn().status;
  if (!status.success) {
    throw new Error(`${command} ${args.join(" ")} failed with ${status.code}`);
  }
}

export async function output(
  command: string,
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
    ...options,
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}
