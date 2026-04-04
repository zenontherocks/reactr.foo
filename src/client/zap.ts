import { getAuth, signEvent } from "./auth";
import { getRelays } from "./pool";
import { getCachedProfile, fetchProfile } from "./profile";
import { lightningAddressToUrl, fetchLnurlPayParams, requestInvoice } from "./lnurl";
import type { Event } from "./pool";

// ── NIP-57 Zap Flow ──────────────────────────────────────────────────────────

export interface ZapParams {
  targetEvent: Event;
  amountSats: number;
  comment?: string;
}

/**
 * Execute the full zap flow:
 * 1. Resolve target's Lightning address
 * 2. Fetch LNURL-pay params
 * 3. Build and sign a kind-9734 zap request
 * 4. Send zap request to LNURL callback
 * 5. Return the bolt11 invoice for the user to pay
 */
export async function createZap(params: ZapParams): Promise<string> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  // 1. Get the target's Lightning address from their profile
  let profile = getCachedProfile(params.targetEvent.pubkey);
  if (!profile) {
    profile = await fetchProfile(params.targetEvent.pubkey);
  }
  if (!profile) throw new Error("Could not fetch target's profile");

  const lud16 = profile.lud16;
  const lud06 = profile.lud06;
  if (!lud16 && !lud06) throw new Error("Target has no Lightning address");

  // 2. Resolve LNURL endpoint
  let lnurlEndpoint: string;
  if (lud16) {
    lnurlEndpoint = lightningAddressToUrl(lud16);
  } else {
    // lud06 is a bech32-encoded LNURL — for now just use lud16
    throw new Error("Only lud16 (Lightning addresses) are supported for now");
  }

  // 3. Fetch pay parameters
  const payParams = await fetchLnurlPayParams(lnurlEndpoint);

  const amountMsat = params.amountSats * 1000;
  if (amountMsat < payParams.minSendable) {
    throw new Error(`Minimum zap is ${Math.ceil(payParams.minSendable / 1000)} sats`);
  }
  if (amountMsat > payParams.maxSendable) {
    throw new Error(`Maximum zap is ${Math.floor(payParams.maxSendable / 1000)} sats`);
  }

  // 4. Build kind-9734 zap request
  const zapRequest = await signEvent({
    kind: 9734,
    content: params.comment ?? "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", params.targetEvent.pubkey],
      ["e", params.targetEvent.id],
      ["amount", String(amountMsat)],
      ["relays", ...getRelays().slice(0, 5)],
    ],
  });

  // 5. Request invoice with zap request attached
  const invoice = await requestInvoice(
    payParams.callback,
    amountMsat,
    JSON.stringify(zapRequest),
  );

  return invoice;
}

/**
 * Try to pay an invoice using WebLN (Alby extension).
 * Returns true if payment succeeded, false if WebLN not available.
 */
export async function payWithWebLN(invoice: string): Promise<boolean> {
  const webln = (window as unknown as Record<string, unknown>).webln as
    | { enable(): Promise<void>; sendPayment(pr: string): Promise<unknown> }
    | undefined;

  if (!webln) return false;

  try {
    await webln.enable();
    await webln.sendPayment(invoice);
    return true;
  } catch {
    return false;
  }
}

// ── Zap receipt parsing (kind 9735) ──────────────────────────────────────────

export interface ZapReceipt {
  eventId: string;
  senderPubkey: string;
  amountMsat: number;
  comment: string;
}

export function parseZapReceipt(event: Event): ZapReceipt | null {
  if (event.kind !== 9735) return null;

  const eTag = event.tags.find((t) => t[0] === "e");
  if (!eTag) return null;

  // The zap request is embedded in the "description" tag
  const descTag = event.tags.find((t) => t[0] === "description");
  if (!descTag || !descTag[1]) return null;

  try {
    const zapRequest = JSON.parse(descTag[1]) as Event;
    const amountTag = zapRequest.tags.find((t) => t[0] === "amount");
    return {
      eventId: eTag[1],
      senderPubkey: zapRequest.pubkey,
      amountMsat: amountTag ? parseInt(amountTag[1], 10) : 0,
      comment: zapRequest.content,
    };
  } catch {
    return null;
  }
}
