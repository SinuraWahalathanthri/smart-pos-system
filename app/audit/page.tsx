import { AuditScreen } from "@/components/dashboard/finance/AuditScreen";

export const metadata = {
  title: "Audit",
  description: "The record of who changed what, and what is worth a look.",
};

export default function Page() {
  return <AuditScreen />;
}
