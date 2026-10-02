import {
  MAX_WEBHOOK_BYTES,
  receiveLinearWebhook,
  scheduleWebhookProcessing,
} from "../../server/linear-webhook.js";

// The Web Request API preserves the exact bytes needed for HMAC verification.
export default {
  async fetch(request: Request) {
    if (request.method !== "POST")
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES)
      return Response.json(
        { error: "Webhook payload too large." },
        { status: 413 },
      );
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_WEBHOOK_BYTES) {
            await reader.cancel();
            return Response.json(
              { error: "Webhook payload too large." },
              { status: 413 },
            );
          }
          chunks.push(value);
        }
      const result = await receiveLinearWebhook(
        Buffer.concat(chunks),
        request.headers,
      );
      if (result.status === 200) scheduleWebhookProcessing();
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return Response.json(
        { error: "Webhook persistence unavailable." },
        { status: 503 },
      );
    }
  },
};
