import { fetchTables } from "@/lib/database-tables";
export const runtime = "nodejs";
export async function POST(request: Request) { return fetchTables(request); }
