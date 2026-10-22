import { deleteAdminSession, validOrigin } from "@/lib/auth";
export async function POST(request:Request){if(!validOrigin(request))return Response.json({error:"invalid_origin"},{status:403});await deleteAdminSession();return Response.json({ok:true})}
