import { ExpensesScreen } from "@/components/dashboard/finance/ExpensesScreen";

export const metadata = {
  title: "Expenses",
  description: "Rent, wages, electricity and every other running cost.",
};

export default function Page() {
  return <ExpensesScreen />;
}
