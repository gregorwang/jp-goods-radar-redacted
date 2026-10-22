import { unauthorized } from "@/lib/api-auth";
import { getEnv } from "@/lib/cloudflare";
import { listingLibraryQuery } from "@/lib/listing-library-query";

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  const query = url.searchParams.get("q")?.slice(0, 100);
  const { sql, values } = listingLibraryQuery({ source, query: query ?? null });
  const statement = getEnv().DB.prepare(sql);
  const result = values.length ? await statement.bind(...values).all() : await statement.all();
  return Response.json({ items: result.results });
}
