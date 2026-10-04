import { abortableDelay, superviseConnector } from "../apps/connector/supervisor.ts";
import { BunnyHoleClient, type Session } from "../apps/connector/client.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("backoff delay finishes on expiry, cancellation and already-aborted signals", async () => {
  const controller = new AbortController();
  await abortableDelay(1, controller.signal);
  const pending = abortableDelay(60000, controller.signal);
  controller.abort();
  await pending;
  await abortableDelay(60000, controller.signal);
});
Deno.test("supervisor stops during successful and failed acquisition without spawning or waiting", async () => {
  for (const failure of [false, true]) {
    const controller = new AbortController();
    let runs = 0;
    let waits = 0;
    await superviseConnector({
      client: new BunnyHoleClient("https://hole.example.com"),
      credentials: {
        url: "https://hole.example.com/",
        identityPublicKey: "",
        enrollmentId: "",
        publicKey: "",
        privateKey: "",
      },
      signal: controller.signal,
      executable: "absent",
      transport: "wss",
      acquire: () => {
        controller.abort();
        return failure
          ? Promise.reject(new Error("cancelled"))
          : Promise.resolve({} as Session);
      },
    }, {
      run: () => {
        runs++;
        return Promise.resolve(0);
      },
      wait: () => {
        waits++;
        return Promise.resolve();
      },
    });
    assertEquals(runs, 0);
    assertEquals(waits, 0);
  }
});
Deno.test("supervisor bounds exponential backoff and resets after a healthy minute", async () => {
  const controller = new AbortController();
  const previous = Date.now;
  let now = previous();
  let cycles = 0;
  const delays: number[] = [];
  try {
    Date.now = () => now;
    await superviseConnector({
      client: new BunnyHoleClient("https://hole.example.com"),
      credentials: {
        url: "https://hole.example.com/",
        identityPublicKey: "",
        enrollmentId: "",
        publicKey: "",
        privateKey: "",
      },
      signal: controller.signal,
      executable: "absent",
      transport: "wss",
      acquire: () => Promise.resolve({} as Session),
    }, {
      run: () => {
        cycles++;
        if (cycles === 9) now += 60000;
        return Promise.resolve(0);
      },
      wait: (ms) => {
        delays.push(ms);
        if (cycles === 9) controller.abort();
        return Promise.resolve();
      },
    });
    assertEquals(delays.length, 9);
    assert(delays[0] >= 400 && delays[0] <= 600);
    assert(delays[7] >= 24000 && delays[7] <= 36000);
    assert(delays[8] >= 400 && delays[8] <= 600);
  } finally {
    Date.now = previous;
  }
});
