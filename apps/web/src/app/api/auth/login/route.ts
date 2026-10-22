import { createAdminSession, validOrigin, verifyPassword } from "@/lib/auth";
import { z } from "zod";
const schema=z.object({password:z.string().min(1).max(300)});
export async function POST(request:Request){if(!validOrigin(request))return Response.json({error:"invalid_origin"},{status:403});let body:unknown;try{body=await request.json()}catch{return Response.json({error:"invalid_json"},{status:400})}const parsed=schema.safeParse(body);if(!parsed.success)return Response.json({error:"密码格式无效"},{status:400});if(!await verifyPassword(parsed.data.password))return Response.json({error:"密码错误"},{status:401});await createAdminSession();return Response.json({ok:true})}
