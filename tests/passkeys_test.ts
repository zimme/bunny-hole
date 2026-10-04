import { PasskeyService } from "../apps/host/passkeys.ts";
import { HostStore } from "../apps/host/store.ts";
import { virtualPasskey } from "./helpers/virtual_passkey.ts";
import { assertEquals, assertRejects } from "./assert.ts";

const origin = new URL("https://hole.example.com");

Deno.test("passkey authentication binds the signed challenge to one approval flow", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const authenticator = await virtualPasskey(store);
    const service = new PasskeyService(store, origin);
    const first = await service.authenticationOptions("flow-first");
    await service.authenticationOptions("flow-second");
    const response = await authenticator.assertion(first.challenge);
    await assertRejects(
      () => service.authenticate(response, "flow-second"),
      /ceremony expired/,
    );
    await service.authenticate(response, "flow-first");
    assertEquals(store.listPasskeys()[0].counter, 1);
    await assertRejects(
      () => service.authenticate(response, "flow-first"),
      /ceremony expired/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reissuing passkey options invalidates the flow's previous challenge", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const authenticator = await virtualPasskey(store);
    const service = new PasskeyService(store, origin);
    const previous = await service.authenticationOptions("flow-first");
    const current = await service.authenticationOptions("flow-first");
    await assertRejects(
      async () =>
        await service.authenticate(
          await authenticator.assertion(previous.challenge),
          "flow-first",
        ),
      /ceremony expired/,
    );
    await service.authenticate(
      await authenticator.assertion(current.challenge),
      "flow-first",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("registration challenges are bound to one flow and replaced on reissue", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const service = new PasskeyService(store, origin);
    const first = await service.registrationOptions("flow-first");
    await service.registrationOptions("flow-second");
    const purpose = "register:flow-first";
    assertEquals(
      store.consumeAdminChallenge(first.challenge, "register:flow-second", Date.now()),
      false,
    );
    await service.registrationOptions("flow-first");
    assertEquals(
      store.consumeAdminChallenge(first.challenge, purpose, Date.now()),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("real passkey registration persists credentials, excludes duplicates and prevents replay", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const authenticator = await virtualPasskey();
    const service = new PasskeyService(store, origin);
    const options = await service.registrationOptions("registration");
    const response = await authenticator.registration(options.challenge);
    await service.register("owner", response, "registration");
    assertEquals(store.listPasskeys()[0].id, authenticator.id);
    assertEquals(store.listPasskeys()[0].name, "owner");
    assertEquals(
      (await service.registrationOptions("next")).excludeCredentials?.[0].id,
      authenticator.id,
    );
    await assertRejects(
      () => service.register("replay", response, "registration"),
      /expired/,
    );
    const authentication = await service.authenticationOptions("approval");
    await service.authenticate(
      await authenticator.assertion(authentication.challenge),
      "approval",
    );
    assertEquals(store.listPasskeys()[0].counter, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("passkey ceremonies reject malformed data, wrong origin and invalid signatures without updating counters", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const service = new PasskeyService(store, origin);
    await assertRejects(() => service.authenticationOptions("empty"), /no passkeys/);
    const authenticator = await virtualPasskey(store);
    const response = await authenticator.assertion("unissued");
    for (const clientDataJSON of ["!", "bnVsbA", "e30"]) {
      await assertRejects(() =>
        service.authenticate({
          ...response,
          response: { ...response.response, clientDataJSON },
        }, "flow"), /authentication failed/);
    }
    await assertRejects(
      () => service.authenticate({ ...response, id: "unknown" }, "flow"),
      /authentication failed/,
    );
    for (const invalid of ["origin", "signature"]) {
      const options = await service.authenticationOptions("flow");
      const assertion = await authenticator.assertion(options.challenge);
      if (invalid === "signature") assertion.response.signature = "AAAA";
      else {assertion.response.clientDataJSON = btoa(
          JSON.stringify({
            type: "webauthn.get",
            challenge: options.challenge,
            origin: "https://attacker.test",
          }),
        ).replace(/=+$/, "");}
      await assertRejects(
        () => service.authenticate(assertion, "flow"),
        /authentication failed/,
      );
      assertEquals(store.listPasskeys()[0].counter, 0);
      await assertRejects(() => service.authenticate(assertion, "flow"), /expired/);
    }
    const options = await service.registrationOptions("register");
    const registration = await authenticator.registration(options.challenge);
    await assertRejects(
      () =>
        service.register("owner", {
          ...registration,
          response: { ...registration.response, clientDataJSON: "!" },
        }, "register"),
      /registration failed/,
    );
    await assertRejects(
      () =>
        service.register("owner", {
          ...registration,
          response: { ...registration.response, attestationObject: "AAAA" },
        }, "register"),
      /registration failed/,
    );
    await assertRejects(
      () => service.register("owner", registration, "register"),
      /expired/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
