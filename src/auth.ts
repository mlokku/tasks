import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

export type AuthStatus = {
  authenticated: boolean;
  bootstrapMode: boolean;
};

export type PasskeyInfo = {
  id: string;
  name: string;
  createdAt: string;
  transports: string[];
};

async function handleResponse(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
  return handleResponse(res) as Promise<AuthStatus>;
}

export async function performRegistration(passkeyName: string): Promise<void> {
  const optRes = await fetch("/api/auth/register/options", { method: "POST" });
  if (!optRes.ok) {
    const body = await optRes.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to get registration options");
  }
  const options = await optRes.json();

  const credential = await startRegistration({ optionsJSON: options });

  await handleResponse(
    await fetch("/api/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credential, passkeyName })
    })
  );
}

export async function performAuthentication(): Promise<void> {
  const optRes = await fetch("/api/auth/authenticate/options", { method: "POST" });
  if (!optRes.ok) {
    const body = await optRes.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to get authentication options");
  }
  const options = await optRes.json();

  const credential = await startAuthentication({ optionsJSON: options });

  await handleResponse(
    await fetch("/api/auth/authenticate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential)
    })
  );
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  return handleResponse(await fetch("/api/auth/passkeys")) as Promise<PasskeyInfo[]>;
}

export async function deletePasskey(id: string): Promise<void> {
  await handleResponse(
    await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" })
  );
}
