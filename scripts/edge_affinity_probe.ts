interface Diagnostic {
  instanceId: string;
  authenticatedConnectors: number;
}

const baseUrl = new URL(Deno.args[0] ?? "");
const publicPath = Deno.args[1] ?? "/";
const token = Deno.env.get("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN");
if (!token) {
  throw new Error(
    "Set BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN in this private terminal",
  );
}
if (!publicPath.startsWith("/") || publicPath.startsWith("//")) {
  throw new Error("public probe path must begin with one slash");
}

const samples = 40;
const diagnostics = new Map<string, { samples: number; connectorSamples: number }>();
const publicResults = new Map<
  string,
  { samples: number; statuses: Map<number, number> }
>();

for (let offset = 0; offset < samples; offset += 5) {
  await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const nonce = crypto.randomUUID();
    const diagnosticUrl = new URL(
      `/_bunny/edge/diagnostics?sample=${offset + index}&nonce=${nonce}`,
      baseUrl,
    );
    const diagnosticResponse = await fetch(diagnosticUrl, {
      headers: { "x-bunny-hole-diagnostic-token": token },
    });
    if (!diagnosticResponse.ok) {
      throw new Error(`diagnostic request failed: ${diagnosticResponse.status}`);
    }
    const diagnostic = await diagnosticResponse.json() as Diagnostic;
    const current = diagnostics.get(diagnostic.instanceId) ??
      { samples: 0, connectorSamples: 0 };
    current.samples++;
    if (diagnostic.authenticatedConnectors > 0) current.connectorSamples++;
    diagnostics.set(diagnostic.instanceId, current);

    const publicUrl = new URL(publicPath, baseUrl);
    publicUrl.searchParams.set("_bunny_probe", nonce);
    const publicResponse = await fetch(publicUrl, {
      headers: { "cache-control": "no-cache" },
    });
    const instance = publicResponse.headers.get("x-bunny-hole-edge-instance") ??
      "[missing]";
    const result = publicResults.get(instance) ??
      { samples: 0, statuses: new Map<number, number>() };
    result.samples++;
    result.statuses.set(
      publicResponse.status,
      (result.statuses.get(publicResponse.status) ?? 0) + 1,
    );
    publicResults.set(instance, result);
    await publicResponse.body?.cancel();
  }));
}

console.log(JSON.stringify(
  {
    target: baseUrl.origin,
    publicPath,
    samples,
    diagnostics: Object.fromEntries(diagnostics),
    publicResults: Object.fromEntries(
      [...publicResults].map(([instance, value]) => [
        instance,
        {
          samples: value.samples,
          statuses: Object.fromEntries(value.statuses),
        },
      ]),
    ),
    interpretation: diagnostics.size === 1 &&
        [...diagnostics.values()].every((value) =>
          value.connectorSamples === value.samples
        )
      ? "This run observed one connector-owning isolate; repeat from other regions and under load."
      : "This run observed isolate divergence or an isolate without the connector.",
  },
  null,
  2,
));
