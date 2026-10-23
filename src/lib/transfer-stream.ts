import type { TransferProgress } from "./transfer-types";

// Streaming is opt-in, so existing API clients retain their JSON contract.
// A disconnected viewer must not interrupt an insert or its rollback.
export async function transferResponse<T>(
  request: Request,
  run: (progress: (event: TransferProgress) => void) => Promise<T>,
  failure: (error: unknown, stage?: string) => Response,
) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    try { return Response.json(await run(() => {})); }
    catch (error) { return failure(error); }
  }
  let connected = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event)+"\n")); }
        catch { connected = false; }
      };
      let stage = "request", failedStage: string | undefined;
      try {
        const data = await run(event => {
          stage = event.stage;
          if (event.level === "error") failedStage = stage;
          send({type:"progress",event});
        });
        send({type:"result",data});
      } catch (error) {
        send({type:"error",data:await failure(error,failedStage ?? stage).json()});
      } finally {
        if (connected) controller.close();
      }
    },
    cancel() { connected = false; },
  });
  return new Response(stream,{headers:{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store, no-transform","X-Accel-Buffering":"no"}});
}
