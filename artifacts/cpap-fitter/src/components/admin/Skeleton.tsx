// Skeleton placeholder — pairs with the `.skeleton` utility in
// index.css. Used by tables / detail panels while data is loading so
// the page reserves layout space immediately and a value swap doesn't
// shift content.

import type { CSSProperties } from "react";

export function Skeleton({
  width,
  height = 12,
  rounded = 6,
  className = "",
  style,
}: {
  width?: number | string;
  height?: number | string;
  rounded?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skeleton inline-block ${className}`}
      style={{
        width: width ?? "100%",
        height,
        borderRadius: rounded,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function SkeletonRow({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2.5" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} height={14} width={`${85 - i * 12}%`} />
      ))}
    </div>
  );
}
