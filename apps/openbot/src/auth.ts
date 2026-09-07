import { getPairingTokenFromUrl, stripPairingTokenFromUrl } from "@t3tools/shared/remote";

/**
 * Same-origin session bootstrap. The T3 server authenticates this browser with
 * an HttpOnly cookie. On first visit the pairing link carries a one-time token
 * in the URL hash; exchanging it sets the cookie, after which every reload and
 * the WebSocket upgrade are authenticated without further work.
 */
export type AuthGateState =
  | { readonly status: "authenticated" }
  | { readonly status: "requires-pairing"; readonly errorMessage: string | null };

async function fetchSessionAuthenticated(): Promise<boolean> {
  const response = await fetch("/api/auth/session", { credentials: "include" });
  if (!response.ok) return false;
  const body = (await response.json()) as { readonly authenticated?: boolean };
  return body.authenticated === true;
}

async function exchangePairingToken(credential: string): Promise<void> {
  const response = await fetch("/api/auth/browser-session", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) {
    throw new Error(`Pairing was rejected (${response.status}). Open a fresh pairing link.`);
  }
}

export async function bootstrapAuth(): Promise<AuthGateState> {
  const url = new URL(window.location.href);
  const token = getPairingTokenFromUrl(url);
  if (token !== null) {
    try {
      await exchangePairingToken(token);
    } catch (error) {
      return {
        status: "requires-pairing",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      const stripped = stripPairingTokenFromUrl(url);
      stripped.pathname = "/";
      window.history.replaceState(null, "", stripped.toString());
    }
  }
  return (await fetchSessionAuthenticated())
    ? { status: "authenticated" }
    : { status: "requires-pairing", errorMessage: null };
}
