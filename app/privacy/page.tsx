import { LegalPage } from "@/components/register/LegalPage";
import { PLATFORM_NAME } from "@/lib/registration";

export const metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>Version 2026-10. How {PLATFORM_NAME} handles the personal data given at registration.</p>
      <h2 className="text-base font-semibold">What we collect</h2>
      <p>
        The owner&apos;s name, email and mobile number, and the business&apos;s name, address, phone, tax and
        registration numbers.
      </p>
      <h2 className="text-base font-semibold">Why</h2>
      <p>To check that the business is genuine, to open its shop, and to contact the owner about the account.</p>
      <h2 className="text-base font-semibold">Who can see it</h2>
      <p>
        The applicant and the platform administrators who review applications. Other businesses on the platform never
        see it.
      </p>
      <h2 className="text-base font-semibold">How long it is kept</h2>
      <p>For as long as the account is open, and afterwards only as long as the law requires.</p>
    </LegalPage>
  );
}
