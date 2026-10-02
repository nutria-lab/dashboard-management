import { createServer } from "node:http";
import handler from "./handler.js";
const port = Number(process.env.API_PORT ?? 3001);
createServer(handler).listen(port, "127.0.0.1", () =>
  console.log(`API listening on http://127.0.0.1:${port}`),
);
