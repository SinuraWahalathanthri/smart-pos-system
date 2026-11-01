import { useId } from "react";
import { APP_NAME } from "@/lib/brand";

/**
 * The Tillwise mark, drawn inline so it needs no request and stays sharp at any size.
 * Same shapes as desktop/build/icon.svg (the installer and tab icon); change both together and
 * re-run `npm run icons`. Its colours are fixed: it is the product's mark, not the shop's accent.
 */
export function LogoMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className={className} role="img" aria-label={APP_NAME}>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#c026d3" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="232" fill={`url(#${id}bg)`} />
      <g fill="#ffffff">
        <rect x="224" y="248" width="576" height="164" rx="82" />
        <rect x="430" y="248" width="164" height="528" rx="82" />
      </g>
      <circle cx="712" cy="660" r="84" fill="#34d399" stroke="#ffffff" strokeWidth="20" />
    </svg>
  );
}

/** Mark plus name, for headers. */
export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </span>
  );
}
