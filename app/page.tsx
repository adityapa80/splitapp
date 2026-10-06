import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listGroupsFor } from "@/lib/store";
import { computeBalances } from "@/lib/split";
import HomeClient, { type GroupSummary } from "./HomeClient";

export default async function Home() {
  const me = await currentUser();
  if (!me) redirect("/login");

  const groups: GroupSummary[] = (await listGroupsFor(me))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((g) => {
      const myId = g.members.find((m) => m.email === me)?.id ?? "";
      return { id: g.id, name: g.name, currency: g.currency, memberCount: g.members.length, myBalance: computeBalances(g)[myId] ?? 0 };
    });

  return <HomeClient me={me} groups={groups} />;
}
