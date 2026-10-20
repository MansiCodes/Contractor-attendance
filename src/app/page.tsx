import { redirect } from "next/navigation";
import { getActor } from "@/lib/server/session";

export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  redirect(actor.role === "admin" ? "/admin" : "/attendance");
}
