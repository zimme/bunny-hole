import { loadState, saveState } from "../apps/connector/state.ts";
import { assertEquals, assertRejects } from "./assert.ts";

Deno.test("state replacement preserves the old configuration when the final rename fails", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.json`;
  const original = Deno.rename;
  const state = { version: 1 as const, hosts: {} };
  try {
    await saveState(state, path);
    const before = await Deno.readTextFile(path);
    Deno.rename = (from, to) =>
      String(from).endsWith(".new")
        ? Promise.reject(new Deno.errors.PermissionDenied("injected rename failure"))
        : original(from, to);
    await assertRejects(() => saveState(state, path), /rename failure/);
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
      "config.json",
    ]);
  } finally {
    Deno.rename = original;
    await Deno.remove(directory, { recursive: true });
  }
});
Deno.test("state replacement removes backups after repeated successful saves", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.json`;
  try {
    for (let i = 0; i < 3; i++) await saveState({ version: 1, hosts: {} }, path);
    assertEquals(await loadState(path), { version: 1, hosts: {} });
    assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
      "config.json",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
Deno.test({
  name: "Windows recovers a previous configuration after an interrupted replacement",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    const path = `${directory}/config.json`;
    try {
      await Deno.writeTextFile(
        `${path}.previous`,
        JSON.stringify({ version: 1, hosts: {} }),
      );
      assertEquals(await loadState(path), { version: 1, hosts: {} });
      assertEquals([...Deno.readDirSync(directory)].map((entry) => entry.name), [
        "config.json",
      ]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
