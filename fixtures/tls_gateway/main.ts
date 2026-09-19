const port = Number(Deno.env.get("PORT") ?? "7443");
const certificatePath = Deno.env.get("BUNNY_HOLE_TLS_CERT_PATH") ?? "/tls/tls.crt";
const keyPath = Deno.env.get("BUNNY_HOLE_TLS_KEY_PATH") ?? "/tls/tls.key";

if (import.meta.main) {
  const listener = Deno.listenTls({
    hostname: "0.0.0.0",
    port,
    cert: await Deno.readTextFile(certificatePath),
    key: await Deno.readTextFile(keyPath),
  });
  for await (const client of listener) void proxy(client);
}

async function proxy(client: Deno.Conn): Promise<void> {
  let upstream: Deno.Conn | undefined;
  try {
    upstream = await Deno.connect({ hostname: "host", port: 7000 });
    await Promise.all([
      client.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(client.writable),
    ]);
  } catch {
    // The TLS endpoint is intentionally a minimal transport fixture. Either peer may
    // disconnect while FRP is reconnecting or the test stack is being torn down.
  } finally {
    client.close();
    upstream?.close();
  }
}
