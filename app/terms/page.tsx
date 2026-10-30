import { LegalPage } from "@/components/register/LegalPage";
import { PLATFORM_NAME } from "@/lib/registration";

export const metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>Version 2026-10. These terms cover businesses that register to use {PLATFORM_NAME}.</p>
      <h2 className="text-base font-semibold">Who may register</h2>
      <p>
        A business registers through a person authorised to act for it. The details given at registration must be true,
        and a reviewer may refuse or close an account that is not a genuine business.
      </p>
      <h2 className="text-base font-semibold">Your data</h2>
      <p>
        Sales, stock, customer and staff records belong to the business that entered them. Platform administrators can
        see summary figures to support the service but cannot change a shop&apos;s records.
      </p>
      <h2 className="text-base font-semibold">Your responsibilities</h2>
      <p>
        The business is responsible for its prices, taxes, receipts and the conduct of its staff accounts, and for
        keeping passwords and PINs private.
      </p>
      <h2 className="text-base font-semibold">Suspension</h2>
      <p>
        An account may be suspended for misuse or non-payment. Suspension closes the shop to its staff but does not
        delete its records.
      </p>
    </LegalPage>
  );
}
