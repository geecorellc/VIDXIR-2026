import { SupportInbox } from "@/components/admin/SupportInbox";
export const metadata = { title: "Support — Vidxir AI" };
export default function SupportPage() {
  return (
    <div className="vx-admin" style={{ padding: 0 }}>
      <SupportInbox />
    </div>
  );
}
