import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

let prismaClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (prismaClient) return prismaClient;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "Set DATABASE_URL to the pooled Neon connection string before accessing attendance data.",
    );
  }

  const adapter = new PrismaPg({ connectionString });
  prismaClient = new PrismaClient({ adapter });
  return prismaClient;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prismaClient) return;

  const currentClient = prismaClient;
  prismaClient = undefined;
  await currentClient.$disconnect();
}
