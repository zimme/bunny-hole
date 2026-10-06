import { parseDocument } from "npm:yaml@2.9.0";

Deno.test({
  name:
    "nested Docker selects disjoint bridges and fails before startup on invalid or exhausted routes",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const compose = parseDocument(await Deno.readTextFile("compose.yaml")).toJS();
    const engine = compose.services["docker-engine"];
    if (
      JSON.stringify(engine.entrypoint) !==
        JSON.stringify(["sh", "/docker-engine.sh"]) ||
      !engine.volumes.includes(
        "./.devcontainer/docker-engine.sh:/docker-engine.sh:ro",
      )
    ) throw new Error("Compose must use the address-pool selector");
    const directory = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        `${directory}/ip`,
        '#!/bin/sh\n[ "$(cat "$ROUTE_FIXTURE")" != "ip-error" ] || exit 1\ncat "$ROUTE_FIXTURE"\n',
        { mode: 0o700 },
      );
      await Deno.writeTextFile(
        `${directory}/dockerd-entrypoint.sh`,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$START_FIXTURE"\n',
        { mode: 0o700 },
      );
      const cases: [string, string | undefined][] = [
        ["", "10.240.0.0/16"],
        ["172.18.0.0/16 dev eth0", "10.240.0.0/16"],
        ["10.254.62.0/24 dev eth0", "10.240.0.0/16"],
        ["10.240.23.0/24 dev eth0", "172.30.0.0/16"],
        ["10.240.0.3 dev eth0", "172.30.0.0/16"],
        ["10.239.0.0/16 dev eth0", "10.240.0.0/16"],
        ["10.0.0.0/8 dev eth0\n172.16.0.0/12 dev eth1", "192.168.0.0/16"],
        [
          "10.0.0.0/8 dev eth0\n172.16.0.0/12 dev eth1\n192.168.0.0/16 dev eth2",
          undefined,
        ],
        ["default dev eth0", undefined],
        ["1.2.3.4/33 dev eth0", undefined],
        ["1.2.3.256/24 dev eth0", undefined],
        ["invalid dev eth0", undefined],
        ["ip-error", undefined],
      ];
      for (const [routes, pool] of cases) {
        const routePath = `${directory}/routes`;
        const startPath = `${directory}/started`;
        await Deno.writeTextFile(routePath, routes);
        const result = await new Deno.Command("sh", {
          args: [
            ".devcontainer/docker-engine.sh",
            "--host=tcp://0.0.0.0:2375",
            "--tls=false",
          ],
          env: {
            PATH: `${directory}:${Deno.env.get("PATH")}`,
            ROUTE_FIXTURE: routePath,
            START_FIXTURE: startPath,
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (pool) {
          const expected = [
            "--host=tcp://0.0.0.0:2375",
            "--tls=false",
            `--bip=${pool.replace("0.0/16", "0.1/24")}`,
            `--default-address-pool=base=${pool},size=24`,
            "",
          ].join("\n");
          if (!result.success || await Deno.readTextFile(startPath) !== expected) {
            throw new Error(`incorrect pool for ${routes}`);
          }
          await Deno.remove(startPath);
        } else {
          if (result.success) throw new Error(`accepted unsafe routes: ${routes}`);
          try {
            await Deno.stat(startPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
          }
          throw new Error("unsafe routes started Docker");
        }
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
