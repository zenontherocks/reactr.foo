// ── LNURL-pay protocol helpers ───────��───────────────────────────────────────

export interface LnurlPayParams {
  callback: string;
  minSendable: number;  // millisatoshis
  maxSendable: number;  // millisatoshis
  metadata: string;
  tag: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

export interface LnurlPayResponse {
  pr: string;  // bolt11 invoice
  routes?: unknown[];
}

/**
 * Resolve a Lightning address (user@domain) to an LNURL-pay endpoint URL.
 */
export function lightningAddressToUrl(address: string): string {
  const [user, domain] = address.split("@");
  if (!user || !domain) throw new Error("Invalid Lightning address");
  return `https://${domain}/.well-known/lnurlp/${user}`;
}

/**
 * Fetch LNURL-pay parameters. Uses the Worker proxy to avoid CORS issues.
 */
export async function fetchLnurlPayParams(lnurlEndpoint: string): Promise<LnurlPayParams> {
  const proxyUrl = `/api/lnurl?url=${encodeURIComponent(lnurlEndpoint)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`LNURL fetch failed: ${res.status}`);
  const data = await res.json() as LnurlPayParams;
  if (data.tag !== "payRequest") throw new Error("Not a LNURL-pay endpoint");
  return data;
}

/**
 * Request a Lightning invoice from the LNURL callback.
 * Amount is in millisatoshis.
 * Optionally include a nostr zap request event (JSON-encoded).
 */
export async function requestInvoice(
  callback: string,
  amountMsat: number,
  zapRequestJson?: string,
): Promise<string> {
  const url = new URL(callback);
  url.searchParams.set("amount", String(amountMsat));
  if (zapRequestJson) {
    url.searchParams.set("nostr", zapRequestJson);
  }

  // Use proxy for CORS
  const proxyUrl = `/api/lnurl?url=${encodeURIComponent(url.toString())}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`Invoice request failed: ${res.status}`);
  const data = await res.json() as LnurlPayResponse;
  if (!data.pr) throw new Error("No invoice in response");
  return data.pr;
}
