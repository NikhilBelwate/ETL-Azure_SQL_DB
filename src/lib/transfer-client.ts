import type { TransferFailure, TransferProgress, TransferStreamEvent } from "./transfer-types";

export class TransferRequestError extends Error {
  constructor(public failure: TransferFailure) { super(failure.error); }
}

export async function readTransferResponse<T>(response: Response, progress: (event: TransferProgress) => void): Promise<T> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const data = await response.json();
    if (!response.ok) throw new TransferRequestError(data);
    return data;
  }
  if (!response.body) throw new Error("The server returned no progress stream.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", result: T | undefined, complete = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event: TransferStreamEvent<T> = JSON.parse(line);
    if (event.type === "progress") progress(event.event);
    else if (event.type === "error") throw new TransferRequestError(event.data);
    else if (event.type === "result") { result = event.data; complete = true; }
    else throw new Error("The server returned an unsupported progress event.");
  };
  try {
    while (true) {
      const {value,done} = await reader.read();
      buffer += decoder.decode(value,{stream:!done});
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0,newline)); buffer = buffer.slice(newline+1); }
      if (done) break;
    }
    consume(buffer);
    if (!complete) throw new Error("The progress connection ended before a final result was received.");
    return result!;
  } finally { reader.releaseLock(); }
}
