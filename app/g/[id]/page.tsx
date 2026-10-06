import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getGroup, memberEmails } from "@/lib/store";
import GroupView from "./GroupView";

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await currentUser();
  if (!me) redirect(`/login?next=${encodeURIComponent(`/g/${id}`)}`);

  const group = await getGroup(id);
  if (!group || !memberEmails(group).has(me)) {
    return (
      <div className="card empty" style={{ maxWidth: 480, margin: "40px auto" }}>
        <h2>You don&apos;t have access to this group</h2>
        <p>
          You&apos;re signed in as <b>{me}</b>. Ask someone in the group to add this email address to your name, then reload this page.
        </p>
        <a className="btn" href="/">
          Go to your groups
        </a>
      </div>
    );
  }
  return <GroupView id={id} me={me} />;
}
