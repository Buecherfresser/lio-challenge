import { PRODUCT_NAME } from "@/lib/config"

/** Logo and product name, at the top of both views. */
export function ProductMark() {
  return (
    <div className="flex h-8 items-center gap-2 px-2">
      <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
          <path d="M3 4.5h10M3 8h10M3 11.5h6" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight">{PRODUCT_NAME}</span>
    </div>
  )
}
