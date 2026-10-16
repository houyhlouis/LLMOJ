// Passkey (WebAuthn) ceremonies. The backend sends options and expects responses with binary fields as base64url.

export function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  let binary = "";
  new Uint8Array(buffer).forEach(byte => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Browsers offer passkeys only on HTTPS sites (and on localhost). */
export function isPasskeySupported(): boolean {
  return window.isSecureContext && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

interface CredentialDescriptorJson {
  type: "public-key";
  id: string;
  transports?: string[];
}

const descriptors = (list: CredentialDescriptorJson[] = []): PublicKeyCredentialDescriptor[] =>
  list.map(descriptor => ({
    type: descriptor.type,
    id: base64urlToBuffer(descriptor.id),
    transports: descriptor.transports as AuthenticatorTransport[]
  }));

/** Create a passkey from the backend's registration options. */
export async function createPasskey(options: Record<string, any>): Promise<ApiTypes.PasskeyRegistrationDto> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...(options as PublicKeyCredentialCreationOptions),
      challenge: base64urlToBuffer(options.challenge),
      user: { ...options.user, id: base64urlToBuffer(options.user.id) },
      excludeCredentials: descriptors(options.excludeCredentials)
    }
  })) as PublicKeyCredential;
  // getTransports() is missing in older browsers (and in this TypeScript version's DOM types).
  const response = credential.response as AuthenticatorAttestationResponse & { getTransports?: () => string[] };
  return {
    id: bufferToBase64url(credential.rawId),
    clientDataJSON: bufferToBase64url(response.clientDataJSON),
    attestationObject: bufferToBase64url(response.attestationObject),
    transports: typeof response.getTransports === "function" ? response.getTransports() : []
  };
}

/** Sign the backend's challenge with one of the allowed passkeys. */
export async function getPasskeyAssertion(options: Record<string, any>): Promise<ApiTypes.PasskeyAssertionDto> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...(options as PublicKeyCredentialRequestOptions),
      challenge: base64urlToBuffer(options.challenge),
      allowCredentials: descriptors(options.allowCredentials)
    }
  })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: bufferToBase64url(credential.rawId),
    clientDataJSON: bufferToBase64url(response.clientDataJSON),
    authenticatorData: bufferToBase64url(response.authenticatorData),
    signature: bufferToBase64url(response.signature)
  };
}

/** The user dismissed the browser's passkey prompt, or it timed out. */
export const isPasskeyCancelled = (error: unknown) => error instanceof DOMException && error.name === "NotAllowedError";
