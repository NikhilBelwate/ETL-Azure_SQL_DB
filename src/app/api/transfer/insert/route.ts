import { transferErrorResponse, transferService } from "@/lib/sql-transfer";
import { transferResponse } from "@/lib/transfer-stream";
export const runtime = "nodejs";
export async function POST(request: Request) {
  let body: { previewId?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid insert confirmation." }, { status: 400 }); }
  if (!body || typeof body.previewId !== "string") return Response.json({ error: "Fetch source records before confirming an insert." }, { status: 400 });
  return transferResponse(request, progress => transferService.confirm(body.previewId,progress), (error,stage) => transferErrorResponse(error,"insert",stage));
}
