import { hasAdminSession } from "@/lib/auth";
export async function GET(){return Response.json({authenticated:await hasAdminSession()})}
