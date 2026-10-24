import { PurchasesScreen } from "@/components/dashboard/finance/PurchasesScreen";

export const metadata = {
  title: "Purchases",
  description: "Supplier bills and what the shop still owes.",
};

export default function Page() {
  return <PurchasesScreen />;
}
