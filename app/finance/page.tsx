import { FinanceScreen } from "@/components/dashboard/finance/FinanceScreen";

export const metadata = {
  title: "Finance",
  description: "The shop's money: sales, costs, expenses and profit.",
};

export default function Page() {
  return <FinanceScreen />;
}
