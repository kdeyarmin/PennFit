// `Field` — the labelled form-row wrapper shared by the fitter's two
// patient-facing forms (`/order`, kept for tenants that still allow
// patient self-service ordering, and `/fit-request`, where every other
// tenant's fitting now ends).
//
// It lived inside order.tsx until the fit-request form needed the same
// accessibility behaviour: the label/`htmlFor` pairing, the `*` mirrored
// into `aria-required`, and — on error — `aria-invalid` plus an
// `aria-describedby` pointing at a `role="alert"` message. Copying that
// into a second page would have meant two versions of the same a11y
// contract, and only one of them getting the next fix.

import React, { useId, isValidElement, cloneElement } from "react";
import { Label } from "@/components/ui/label";

/**
 * Field — labels every form input with an auto-generated id and binds
 * the <Label htmlFor> to the input via React.cloneElement. Without this,
 * users navigating with screen readers (or who tap the label on mobile
 * to focus the input) get no association between label and control.
 *
 * For composite controls like our Select (which renders a Radix trigger
 * button — not a real form control), set `skipHtmlFor` and the wrapping
 * label is rendered without a `for` attribute (the underlying button
 * gets its own accessible name from its placeholder/value).
 */
export function Field({
  label,
  required,
  error,
  className,
  skipHtmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  skipHtmlFor?: boolean;
  children: React.ReactNode;
}) {
  const generatedId = useId();
  const errorId = `${generatedId}-error`;
  // When the field has an error we clone the child so screen readers
  // announce both the invalid state (aria-invalid) and the error
  // text (via aria-describedby). The role="alert" on the message
  // also re-announces it when it appears or changes.
  type ChildProps = {
    id?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-describedby"?: string;
    "aria-required"?: boolean;
  };
  const child =
    !skipHtmlFor && isValidElement(children)
      ? cloneElement(children as React.ReactElement<ChildProps>, {
          id:
            (children as React.ReactElement<ChildProps>).props.id ??
            generatedId,
          // Forward the required state to assistive tech — the visual `*`
          // alone never reaches a screen reader.
          ...(required ? { "aria-required": true } : {}),
          ...(error
            ? {
                "aria-invalid": true,
                "aria-describedby": errorId,
              }
            : {}),
        })
      : children;
  const inputId = skipHtmlFor
    ? undefined
    : isValidElement(children)
      ? ((children as React.ReactElement<{ id?: string }>).props.id ??
        generatedId)
      : undefined;

  return (
    <div className={className}>
      <Label htmlFor={inputId} className="text-sm font-medium mb-1.5 block">
        {label}
        {required && (
          <span className="text-destructive ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {child}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive mt-1">
          {error}
        </p>
      )}
    </div>
  );
}
