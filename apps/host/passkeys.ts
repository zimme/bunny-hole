import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeBase64Url, ValidationError } from "../../packages/api/mod.ts";
import type { HostStore } from "./store.ts";

export class PasskeyService {
  readonly rpId: string;
  readonly origin: string;

  constructor(private store: HostStore, publicUrl: URL) {
    this.rpId = publicUrl.hostname;
    this.origin = publicUrl.origin;
  }

  async registrationOptions(name: string) {
    const passkeys = this.store.listPasskeys();
    const options = await generateRegistrationOptions({
      rpName: "Bunny Hole",
      rpID: this.rpId,
      userName: "owner",
      userDisplayName: "Bunny Hole owner",
      attestationType: "none",
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: [-7, -257],
    });
    this.store.saveAdminChallenge(
      options.challenge,
      `register:${name}`,
      Date.now() + 5 * 60_000,
    );
    return options;
  }

  async register(name: string, response: RegistrationResponseJSON): Promise<void> {
    let challenge: string;
    try {
      challenge = clientChallenge(response.response.clientDataJSON);
    } catch {
      throw new ValidationError("passkey registration failed");
    }
    if (!this.store.consumeAdminChallenge(challenge, `register:${name}`, Date.now())) {
      throw new ValidationError("registration ceremony expired");
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new ValidationError("passkey registration failed");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new ValidationError("passkey registration failed");
    }
    const info = verification.registrationInfo;
    this.store.savePasskey({
      id: info.credential.id,
      name,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
  }

  async authenticationOptions() {
    const passkeys = this.store.listPasskeys();
    if (passkeys.length === 0) throw new ValidationError("no passkeys are registered");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: "required",
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
    });
    this.store.saveAdminChallenge(
      options.challenge,
      "authenticate",
      Date.now() + 2 * 60_000,
    );
    return options;
  }

  async authenticate(response: AuthenticationResponseJSON): Promise<void> {
    let passkey;
    let challenge: string;
    try {
      passkey = this.store.listPasskeys().find((value) => value.id === response.id);
      challenge = clientChallenge(response.response.clientDataJSON);
    } catch {
      throw new ValidationError("passkey authentication failed");
    }
    if (!passkey) throw new ValidationError("passkey authentication failed");
    if (!this.store.consumeAdminChallenge(challenge, "authenticate", Date.now())) {
      throw new ValidationError("authentication ceremony expired");
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: ownedBytes(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      throw new ValidationError("passkey authentication failed");
    }
    if (!verification.verified) {
      throw new ValidationError("passkey authentication failed");
    }
    this.store.updatePasskeyCounter(
      passkey.id,
      verification.authenticationInfo.newCounter,
    );
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(value.length);
  output.set(value);
  return output;
}

function clientChallenge(clientData: string): string {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(clientData)),
    );
    if (
      typeof value === "object" && value !== null && "challenge" in value &&
      typeof value.challenge === "string"
    ) {
      return value.challenge;
    }
  } catch {
    // Return one generic ceremony error.
  }
  throw new ValidationError("invalid WebAuthn response");
}
