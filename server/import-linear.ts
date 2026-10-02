import "dotenv/config";
import { importLinearHistory } from "./linear-sync.js";
import { disconnectPrismaClient } from "./db.js";
try {
  await importLinearHistory();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await disconnectPrismaClient();
}
