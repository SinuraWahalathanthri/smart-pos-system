import { getSupabase } from "@/lib/supabase/client";

/**
 * Vendor registration (0029): a business signs itself up, a platform admin approves it.
 *
 * Everything the browser does here goes through Supabase Auth (the account) or an authenticated RPC
 * (the application). Nothing is callable while signed out, which is why the account comes first.
 */

/** The product's name on the public pages. A shop's own name is used everywhere once it exists. */
export const PLATFORM_NAME = process.env.NEXT_PUBLIC_PLATFORM_NAME || "Smart POS";

/** Cloudflare Turnstile site key. Public by design; the secret lives in Supabase Auth's settings. */
export const CAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

export type BusinessType =
  | "retail"
  | "grocery"
  | "restaurant"
  | "pharmacy"
  | "services"
  | "wholesale"
  | "manufacturing"
  | "other";

/** Must match the check constraint on vendor_applications.business_type. */
export const BUSINESS_TYPES: { id: BusinessType; label: string; hint: string }[] = [
  { id: "retail", label: "Retail shop", hint: "Clothing, electronics, hardware, books" },
  { id: "grocery", label: "Grocery or mini-market", hint: "Packaged food, household goods" },
  { id: "restaurant", label: "Restaurant or café", hint: "Food and drink served to order" },
  { id: "pharmacy", label: "Pharmacy", hint: "Medicines and health products" },
  { id: "services", label: "Services", hint: "Salon, repairs, laundry" },
  { id: "wholesale", label: "Wholesale or distribution", hint: "Selling in bulk to other businesses" },
  { id: "manufacturing", label: "Manufacturer with a shop", hint: "Makes what it sells, like spices or bakery" },
  { id: "other", label: "Something else", hint: "Tell us in the business name" },
];

/** A short list with the currency each country trades in; the currency stays editable. */
export const COUNTRIES: { name: string; currency: string }[] = [
  { name: "Sri Lanka", currency: "LKR" },
  { name: "India", currency: "INR" },
  { name: "Maldives", currency: "MVR" },
  { name: "Bangladesh", currency: "BDT" },
  { name: "Pakistan", currency: "PKR" },
  { name: "Nepal", currency: "NPR" },
  { name: "United Arab Emirates", currency: "AED" },
  { name: "United Kingdom", currency: "GBP" },
  { name: "United States", currency: "USD" },
  { name: "Australia", currency: "AUD" },
  { name: "Other", currency: "USD" },
];

export type ApplicationStatus = "submitted" | "info_requested" | "approved" | "rejected" | "withdrawn";

export type VendorApplication = {
  id: string;
  status: ApplicationStatus;
  owner_name: string;
  owner_phone: string | null;
  legal_name: string;
  trading_name: string | null;
  business_type: BusinessType;
  country: string;
  currency: string;
  address: string | null;
  phone: string | null;
  tax_number: string | null;
  registration_number: string | null;
  locations_count: number;
  tills_count: number;
  terms_version: string;
  submitted_at: string;
  reviewed_at: string | null;
  decision_reason: string | null;
  store_id: string | null;
};

export type MyApplication = {
  email: string | null;
  email_verified: boolean;
  has_shop: boolean;
  terms_version: string;
  application: VendorApplication | null;
};

/** What the applicant fills in. Matches the keys submit_vendor_application() reads. */
export type ApplicationInput = {
  owner_name: string;
  owner_phone: string;
  legal_name: string;
  trading_name: string;
  business_type: BusinessType | "";
  country: string;
  currency: string;
  address: string;
  phone: string;
  tax_number: string;
  registration_number: string;
  locations_count: number;
  tills_count: number;
};

export type ReviewApplication = VendorApplication & { owner_email: string; store_name: string | null };

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  submitted: "Waiting for review",
  info_requested: "More information needed",
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
};

export const MIN_PASSWORD = 8;

/** A rough strength meter: enough to stop "password1", not a policy. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < MIN_PASSWORD) return { score: 0, label: `At least ${MIN_PASSWORD} characters` };
  let kinds = 0;
  if (/[a-z]/.test(pw)) kinds++;
  if (/[A-Z]/.test(pw)) kinds++;
  if (/\d/.test(pw)) kinds++;
  if (/[^A-Za-z0-9]/.test(pw)) kinds++;
  if (pw.length >= 14 && kinds >= 3) return { score: 3, label: "Strong" };
  if (pw.length >= 10 && kinds >= 2) return { score: 2, label: "Good" };
  return { score: 1, label: "Weak - add length, numbers or symbols" };
}

export const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

/**
 * Is this the installed desktop till? The preload bridge defines window.posDesktop (possibly null)
 * only inside Electron. A till is signed in as a device account, so it never shows the public
 * landing page or the registration link.
 */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && window.posDesktop !== undefined;
}

/** Supabase Auth error text, rephrased for a shop owner. */
export function explainAuthError(message: string): string {
  if (/already registered|already exists|user_already_exists/i.test(message)) {
    return "An account with that email already exists. Sign in instead.";
  }
  if (/password/i.test(message) && /(weak|short|least)/i.test(message)) {
    return `Choose a stronger password (at least ${MIN_PASSWORD} characters).`;
  }
  if (/captcha/i.test(message)) return "Complete the human check, then try again.";
  if (/rate limit|too many/i.test(message)) return "Too many attempts. Wait a few minutes and try again.";
  if (/fetch|network/i.test(message)) return "No connection to the server. Check the internet and try again.";
  return message;
}

/** Create the owner's account. Supabase emails the verification link to `email`. */
export async function registerAccount(input: {
  email: string;
  password: string;
  fullName: string;
  captchaToken?: string | null;
}): Promise<{ needsVerification: boolean }> {
  const { data, error } = await getSupabase().auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      data: { full_name: input.fullName.trim() },
      emailRedirectTo: `${window.location.origin}/onboarding`,
      captchaToken: input.captchaToken ?? undefined,
    },
  });
  if (error) throw new Error(explainAuthError(error.message));
  // Supabase answers an existing address with an empty identities list instead of an error, so an
  // attacker cannot probe which emails are registered. Tell the real owner what to do.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error("An account with that email already exists. Sign in instead.");
  }
  return { needsVerification: !data.session };
}

export async function resendVerification(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resend({
    type: "signup",
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: `${window.location.origin}/onboarding` },
  });
  if (error) throw new Error(explainAuthError(error.message));
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) {
    if (error.code === "PGRST202" || /schema cache/i.test(error.message)) {
      throw new Error(
        "Registration is not set up on this server yet. Run supabase/migrations/0029_vendor_registration.sql, then reload.",
      );
    }
    throw new Error(error.message);
  }
  return data as T;
}

export const myApplication = () => rpc<MyApplication>("my_vendor_application");

export function submitApplication(input: ApplicationInput, termsVersion: string) {
  return rpc<{ id: string; status: ApplicationStatus }>("submit_vendor_application", {
    p_application: { ...input, terms_version: termsVersion },
  });
}

export const withdrawApplication = () => rpc<{ id: string }>("withdraw_vendor_application");

export async function listApplications(status: "open" | ApplicationStatus | "all" = "open") {
  return (
    (await rpc<ReviewApplication[] | null>("platform_vendor_applications", {
      p_status: status === "open" ? null : status,
    })) ?? []
  );
}

export function reviewApplication(id: string, decision: "approve" | "reject" | "request_info", reason?: string) {
  return rpc<{ status: ApplicationStatus }>("platform_review_vendor_application", {
    p_application: id,
    p_decision: decision,
    p_reason: reason?.trim() || null,
  });
}

export const registrationSettings = () =>
  rpc<{ auto_approve_vendors: boolean; terms_version: string }>("platform_registration_settings");

export const setAutoApprove = (on: boolean) =>
  rpc<{ auto_approve_vendors: boolean }>("platform_set_auto_approve", { p_on: on });

/** The application as the form edits it, starting from what was sent before (after "request info"). */
export function inputFrom(app: VendorApplication | null, fallbackName = ""): ApplicationInput {
  return {
    owner_name: app?.owner_name ?? fallbackName,
    owner_phone: app?.owner_phone ?? "",
    legal_name: app?.legal_name ?? "",
    trading_name: app?.trading_name ?? "",
    business_type: app?.business_type ?? "",
    country: app?.country ?? "Sri Lanka",
    currency: app?.currency ?? "LKR",
    address: app?.address ?? "",
    phone: app?.phone ?? "",
    tax_number: app?.tax_number ?? "",
    registration_number: app?.registration_number ?? "",
    locations_count: app?.locations_count ?? 1,
    tills_count: app?.tills_count ?? 1,
  };
}

/** Client-side check before the round trip; the server repeats every rule. */
export function validateApplication(input: ApplicationInput): string | null {
  if (!input.owner_name.trim()) return "Enter your full name.";
  if (!input.legal_name.trim()) return "Enter the business name.";
  if (!input.business_type) return "Choose what kind of business this is.";
  if (!input.country.trim()) return "Choose the country the business trades in.";
  if (!/^[A-Za-z]{3}$/.test(input.currency.trim())) return "Currency must be a three-letter code such as LKR.";
  if (!(input.locations_count >= 1) || !(input.tills_count >= 1)) return "Locations and tills must be at least 1.";
  return null;
}
