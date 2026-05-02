// WishlistButton — small heart-icon toggle rendered on shop
// product cards (and any other surface where a "save for later"
// affordance makes sense). State and persistence live in
// lib/wishlist; this is purely the click target + visual state.
//
// Visual model: outlined heart when not saved, gold-filled
// heart when saved, with a subtle scale transition on toggle.
// Floats top-right of the product image on cards (mirroring
// the placement of the Quick view pill on the same card —
// the two affordances live on opposite sides of the same row
// so they don't fight for the same pixels).

import { Heart } from "lucide-react";

import { useWishlist } from "@/lib/wishlist";
import { cn } from "@/lib/utils";

interface Props {
  productId: string;
  /** Used in aria-label and toast text — falls back to "this item". */
  productName?: string;
  /**
   * Visual size. `sm` for in-card (the default — keeps the
   * top corner clean) and `md` for taller standalone surfaces
   * like a wishlist-page item card.
   */
  size?: "sm" | "md";
  className?: string;
}

export function WishlistButton({
  productId,
  productName,
  size = "sm",
  className,
}: Props) {
  const { has, toggle } = useWishlist();
  const saved = has(productId);

  return (
    <button
      type="button"
      onClick={(e) => {
        // The button frequently sits inside a clickable card or
        // image link — stop propagation so a heart click doesn't
        // also navigate to the PDP.
        e.stopPropagation();
        e.preventDefault();
        toggle(productId);
      }}
      aria-pressed={saved}
      aria-label={
        saved
          ? `Remove ${productName ?? "this item"} from your wishlist`
          : `Save ${productName ?? "this item"} to your wishlist`
      }
      title={saved ? "Saved — click to remove" : "Save for later"}
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-white/95 backdrop-blur shadow-sm border border-border/60 text-[hsl(var(--penn-navy))] transition-transform hover:scale-105 active:scale-95",
        size === "sm" ? "h-9 w-9" : "h-10 w-10",
        className,
      )}
      data-testid={`wishlist-toggle-${productId}`}
      data-state={saved ? "on" : "off"}
    >
      <Heart
        className={cn(
          size === "sm" ? "w-4 h-4" : "w-[18px] h-[18px]",
          "transition-colors",
          saved
            ? "fill-[hsl(var(--penn-gold))] text-[hsl(var(--penn-gold))]"
            : "text-[hsl(var(--penn-navy))]/70",
        )}
      />
    </button>
  );
}
