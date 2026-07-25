/// <reference path="./bunny-sdk.d.ts" />

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createEdgeRelayHandler, loadEdgeRelayConfig } from "./relay.ts";

const config = loadEdgeRelayConfig({
  get: (name) => Deno.env.get(name),
});

BunnySDK.net.http.serve(createEdgeRelayHandler({ config }));
