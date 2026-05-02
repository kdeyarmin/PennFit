/**
 * UI shims for the four PennPaps storefront-admin pages that were
 * ported here from cpap-fitter during the Task #37 consolidation.
 *
 * Why a shim?
 * -----------
 * The cpap-fitter pages were authored against a shadcn/radix-flavoured
 * primitive set (`@/components/ui/{card,button,badge,input,select,
 * skeleton,alert}`). The dashboard's own design system uses a
 * different, leaner set (`Card`, `Button`, `Spinner`, `Table`, etc.)
 * that is NOT a drop-in replacement.
 *
 * To avoid either (a) rewriting four working pages or (b) pulling
 * the entire shadcn + radix dependency surface into a dashboard
 * that doesn't use it elsewhere, this file exposes the shadcn API
 * shape (Card / CardHeader / Select / SelectTrigger / …) backed by
 * plain Tailwind-styled HTML. The visual fidelity is "close enough"
 * to the rest of the dashboard chrome and the page code drops in
 * unchanged.
 *
 * If the dashboard ever grows a real shadcn install, this file
 * becomes a single-file delete + a re-target of the four page
 * imports.
 *
 * Re-exports are namespaced under `./card`, `./input`, etc. so the
 * page imports keep working with `@/components/ui/<thing>` paths
 * via `vite.config.ts` aliases (see `tsconfig.json` paths block
 * extension below).
 */

import * as React from "react";

/* ----------------------------- cn helper ----------------------------- */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------- Card -------------------------------- */

export const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...rest }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-2xl border border-border/40 bg-white shadow-sm",
      className,
    )}
    {...rest}
  />
));
Card.displayName = "Card";

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...rest }, ref) => (
  <div ref={ref} className={cn("p-5 pb-3", className)} {...rest} />
));
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...rest }, ref) => (
  <h3
    ref={ref}
    className={cn("text-base font-semibold tracking-tight", className)}
    {...rest}
  />
));
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...rest }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...rest}
  />
));
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...rest }, ref) => (
  <div ref={ref} className={cn("p-5 pt-0", className)} {...rest} />
));
CardContent.displayName = "CardContent";

/* ------------------------------ Button ------------------------------- */

type ButtonVariant = "default" | "outline" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "icon";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "bg-slate-900 text-white hover:bg-slate-800 border border-slate-900",
  outline: "bg-white text-slate-900 hover:bg-slate-50 border border-slate-300",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100 border border-transparent",
  destructive: "bg-red-600 text-white hover:bg-red-700 border border-red-600",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  default: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
  icon: "h-9 w-9 p-0",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = "Button";

/* ------------------------------- Badge ------------------------------- */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const BADGE_VARIANT: Record<BadgeVariant, string> = {
  default: "bg-emerald-100 text-emerald-900 border border-emerald-300",
  secondary: "bg-slate-200 text-slate-700 border border-slate-300",
  destructive: "bg-red-100 text-red-900 border border-red-300",
  outline: "bg-transparent text-slate-700 border border-slate-300",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        BADGE_VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}

/* ------------------------------- Input ------------------------------- */

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
      className,
    )}
    {...rest}
  />
));
Input.displayName = "Input";

/* ----------------------------- Skeleton ------------------------------ */

export function Skeleton({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-slate-200", className)}
      {...rest}
    />
  );
}

/* ------------------------------ Select ------------------------------- */
/**
 * Radix-style Select API surface backed by a native <select>. The
 * recovered cpap-fitter pages compose Select like this:
 *
 *   <Select value={status} onValueChange={setStatus}>
 *     <SelectTrigger><SelectValue placeholder="…" /></SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="all">All statuses</SelectItem>
 *       …
 *     </SelectContent>
 *   </Select>
 *
 * To honour that JSX shape without pulling in radix-ui, we walk
 * children to extract the SelectItem `value` + label pairs and
 * render them into a single native <select>. The Trigger / Value
 * children are inspected only to copy the `className` from the
 * Trigger to the native control (so `w-44` etc. stay applied) and
 * to read the optional `placeholder`. Unsupported features (custom
 * item rendering, groups, separators) are intentionally dropped —
 * the four ported pages don't use them.
 */

interface SelectContextValue {
  value: string | undefined;
  onValueChange: (next: string) => void;
  triggerClassName: string;
  placeholder: string;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}

interface CollectedItem {
  value: string;
  label: React.ReactNode;
}

function collectSelectItems(node: React.ReactNode): CollectedItem[] {
  const out: CollectedItem[] = [];
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) return;
    if ((child.type as React.ComponentType | undefined) === SelectItem) {
      out.push({
        value: child.props.value ?? "",
        label: child.props.children,
      });
      return;
    }
    if (child.props && child.props.children !== undefined) {
      out.push(...collectSelectItems(child.props.children));
    }
  });
  return out;
}

function findTriggerProps(node: React.ReactNode): {
  className: string;
  placeholder: string;
} {
  let triggerClassName = "";
  let placeholder = "";
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) return;
    if ((child.type as React.ComponentType | undefined) === SelectTrigger) {
      triggerClassName = child.props.className ?? "";
      // Look one level deeper for SelectValue placeholder
      React.Children.forEach(child.props.children, (inner) => {
        if (!React.isValidElement<{ placeholder?: string }>(inner)) return;
        if ((inner.type as React.ComponentType | undefined) === SelectValue) {
          placeholder = inner.props.placeholder ?? "";
        }
      });
    }
  });
  return { className: triggerClassName, placeholder };
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  children,
}: SelectProps) {
  const items = React.useMemo(() => collectSelectItems(children), [children]);
  const trigger = React.useMemo(() => findTriggerProps(children), [children]);
  const [internal, setInternal] = React.useState<string | undefined>(
    defaultValue,
  );
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  return (
    <SelectContext.Provider
      value={{
        value: current,
        onValueChange: (next) => {
          if (!isControlled) setInternal(next);
          onValueChange?.(next);
        },
        triggerClassName: trigger.className,
        placeholder: trigger.placeholder,
      }}
    >
      <select
        value={current ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (!isControlled) setInternal(next);
          onValueChange?.(next);
        }}
        className={cn(
          "h-10 rounded-md border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
          trigger.className,
        )}
      >
        {trigger.placeholder && current === undefined && (
          <option value="" disabled>
            {trigger.placeholder}
          </option>
        )}
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {typeof item.label === "string" ? item.label : item.value}
          </option>
        ))}
      </select>
    </SelectContext.Provider>
  );
}

/**
 * The remaining Select.* components are tag markers used by the
 * children-walker above. They render `null` so the JSX tree from
 * the original shadcn pages is honoured but no DOM is produced
 * (the native <select> emitted by `Select` is the only output).
 */
export function SelectTrigger(_props: {
  className?: string;
  children?: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}) {
  return null;
}
export function SelectValue(_props: {
  placeholder?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}) {
  return null;
}
export function SelectContent({ children: _ }: { children?: React.ReactNode }) {
  return null;
}
export function SelectItem(_props: {
  value: string;
  children?: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}) {
  return null;
}

/* ------------------------------- Alert ------------------------------- */

type AlertVariant = "default" | "destructive";

const ALERT_VARIANT: Record<AlertVariant, string> = {
  default: "border-slate-300 bg-slate-50 text-slate-900",
  destructive: "border-red-300 bg-red-50 text-red-900",
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

export function Alert({
  className,
  variant = "default",
  children,
  ...rest
}: AlertProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border p-4 text-sm",
        ALERT_VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function AlertTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5
      className={cn("font-semibold leading-tight", className)}
      {...rest}
    />
  );
}

export function AlertDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-sm leading-snug", className)}
      {...rest}
    />
  );
}
