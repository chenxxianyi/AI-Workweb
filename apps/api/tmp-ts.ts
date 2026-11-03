import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./src/generated/prisma/client.js";

const url = "postgresql://aiwb:aiwb_local_dev@127.0.0.1:55432/aiwb_test?schema=public";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const user = await prisma.user.findFirst();
const ws = await prisma.workspace.findFirst({ where: { createdBy: user?.id ?? "" } });
if (user === null || ws === null) { console.log("no data"); process.exit(0); }
const task = await prisma.task.create({ data: { workspaceId: ws.id, createdBy: user.id, title: `ts-probe-${Date.now()}`, dueDate: new Date() } });
await prisma.$executeRawUnsafe(`UPDATE tasks SET updated_at = now() - interval '4 days' WHERE id = $1::uuid`, task.id);
const read = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
const raw = await prisma.$queryRawUnsafe<{ updated_at: Date; utc: string }[]>(`select updated_at, (updated_at at time zone 'UTC')::text as utc from tasks where id = $1::uuid`, task.id);
console.log("RESULT " + JSON.stringify({ id: task.id, prismaRead: read.updatedAt.toISOString(), rawRead: String(raw[0]?.updated_at), pgUtc: raw[0]?.utc }));
await prisma.$disconnect();