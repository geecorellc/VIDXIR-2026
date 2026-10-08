import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { VidxirLogo } from "@/components/ui/VidxirLogo";
import { SupportInbox } from "@/components/admin/SupportInbox";
export const metadata = { title: "Support — Vidxir AI" };
export default async function SupportPage() {
  const session = await getSession();
  return (
    <div className="vx-admin">
      <header className="vx-admin-top" style={{ marginBottom: 30 }}>
        <Link href="/">
          <VidxirLogo size={20} />
        </Link>
        <Link href={session ? "/dashboard" : "/login"}>
          {session ? "Back to studio" : "Sign in"}
        </Link>
      </header>
      <SupportInbox guest={!session} />
    </div>
  );
}
