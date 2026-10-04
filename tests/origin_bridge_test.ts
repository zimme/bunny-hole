import { createServer } from "node:https";
import { request } from "node:http";
import { prepareOrigins } from "../apps/connector/origin_bridge.ts";
import type { Session } from "../apps/connector/client.ts";
import { assertEquals } from "./assert.ts";

Deno.test("HTTPS origins verify certificate trust and hostname while streaming", async () => {
  const directory = await Deno.makeTempDir();
  const result = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${directory}/key.pem`,
      "-out",
      `${directory}/cert.pem`,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(result.code, 0);
  const server = createServer({
    key: await Deno.readTextFile(`${directory}/key.pem`),
    cert: await Deno.readTextFile(`${directory}/cert.pem`),
  }, (req, res) => {
    res.setHeader("set-cookie", ["a=1", "b=2"]);
    req.pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const session = {
    routes: [{
      id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
      enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
      name: "tls",
      protocol: "https",
      hostname: "app.example.com",
      targetHost: "127.0.0.1",
      targetPort: address.port,
      allowPrivateNetwork: false,
      active: true,
    }],
  } as Session;
  try {
    for (const scenario of ["untrusted", "trusted", "wrong-host"]) {
      const candidate = structuredClone(session);
      if (scenario === "trusted") candidate.routes[0].targetHost = "localhost";
      if (scenario === "wrong-host") candidate.routes[0].targetHost = "127.0.0.2";
      const bridge = await prepareOrigins(
        candidate,
        scenario === "untrusted" ? undefined : `${directory}/cert.pem`,
      );
      try {
        const response = await new Promise<
          { status: number; bytes: number[]; cookies: string[] }
        >(
          (resolve, reject) => {
            const client = request({
              hostname: "127.0.0.1",
              port: bridge.session.routes[0].targetPort,
              path: "/binary",
              method: "POST",
              headers: { host: "app.example.com", connection: "close" },
            }, (response) => {
              void (async () => {
                const bytes: number[] = [];
                for await (const chunk of response) bytes.push(...chunk);
                resolve({
                  status: response.statusCode!,
                  bytes,
                  cookies: response.headers["set-cookie"] ?? [],
                });
              })().catch(reject);
            });
            client.on("error", reject);
            client.end(new Uint8Array([0, 1, 255]));
          },
        );
        assertEquals(response.status, scenario === "trusted" ? 200 : 502);
        if (scenario === "trusted") {
          assertEquals(response.bytes, [0, 1, 255]);
          assertEquals(response.cookies, ["a=1", "b=2"]);
        }
      } finally {
        await bridge.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await Deno.remove(directory, { recursive: true });
  }
});
