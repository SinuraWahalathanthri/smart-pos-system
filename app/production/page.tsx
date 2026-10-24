import { ProductionScreen } from "@/components/dashboard/finance/ProductionScreen";

export const metadata = {
  title: "Production",
  description: "Batches made in the shop and what each unit cost.",
};

export default function Page() {
  return <ProductionScreen />;
}
