import { transferErrorResponse, transferService } from "@/lib/sql-transfer";
import type { PreviewRequest } from "@/lib/transfer-types";
import { transferResponse } from "@/lib/transfer-stream";
export const runtime = "nodejs";
export async function POST(request: Request) {
  let body: PreviewRequest;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid source fetch request." }, { status: 400 }); }
  return transferResponse(request, progress => transferService.preview(body,progress), (error,stage) => transferErrorResponse(error,"fetch",stage));
}
