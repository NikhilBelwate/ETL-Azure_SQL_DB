import { transferService } from "@/lib/sql-transfer";
import type { QueryVerificationRequest } from "@/lib/transfer-types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: QueryVerificationRequest;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid query verification request." }, { status: 400 }); }
  try { return Response.json(await transferService.verifyQuery(body)); }
  catch (error) {
    const detail = error as { code?: string };
    const message = detail?.code === "ELOGIN" ? "Database sign-in failed. Check your connection credentials."
      : detail?.code === "ETIMEOUT" || detail?.code === "ESOCKET" ? "Unable to reach the database. Check connectivity and retry."
      : error instanceof Error ? error.message : "Query verification failed. Check the query and database connections.";
    return Response.json({ error: message }, { status: 400 });
  }
}
