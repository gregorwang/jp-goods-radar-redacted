import { redirect } from "next/navigation";
import type { Route } from "next";

export default function ListingDetailPage() {
  redirect("/changes" as Route);
}
