import { isIP } from "node:net";

export const runtime = "nodejs";

export async function GET() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Public IP lookup failed");

    const data = await response.json();
    if (typeof data.ip !== "string" || isIP(data.ip) === 0) {
      throw new Error("Invalid public IP response");
    }

    return Response.json({ ip: data.ip }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Public IP unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
