import { ProfitabilityScreen } from "@/components/dashboard/finance/ProfitabilityScreen";

export const metadata = {
  title: "Profitability",
  description: "What each product earns, and its margin.",
};

export default function Page() {
  return <ProfitabilityScreen />;
}
