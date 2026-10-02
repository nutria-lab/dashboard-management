import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Client generation and schema-only diffs do not need a database connection.
    // Prisma commands that connect to the database still require DIRECT_URL.
    url: process.env.DIRECT_URL ?? "",
  },
});
