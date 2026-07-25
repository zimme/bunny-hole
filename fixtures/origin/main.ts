const port = Number(Deno.env.get("PORT") ?? "3000");

if (import.meta.main) {
  Deno.serve({ hostname: "0.0.0.0", port }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (url.pathname === "/binary") {
      return new Response(body, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url.pathname === "/stream") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first:"));
            controller.enqueue(body);
            controller.enqueue(new TextEncoder().encode(":last"));
            controller.close();
          },
        }),
      );
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => headers[name] = value);
    return Response.json({
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body: new TextDecoder().decode(body),
    });
  });
}
