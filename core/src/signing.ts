const BASE = "https://timetableapi.ptv.vic.gov.au";

export async function signedUrl(pathAndQuery: string, devId: string, key: string): Promise<string> {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const toSign = `${pathAndQuery}${sep}devid=${devId}`;
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(toSign));
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${BASE}${toSign}&signature=${hex}`;
}
