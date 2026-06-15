import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface AutocompleteOption {
  /** Text written into the field when this option is chosen. */
  value: string;
  /** Display label in the dropdown (defaults to `value`). */
  label?: string;
  /** Optional secondary line shown muted beneath the label. */
  description?: string;
}

type RawOption = AutocompleteOption | string;

function normalize(option: RawOption): AutocompleteOption {
  return typeof option === "string" ? { value: option } : option;
}

export interface AutocompleteProps extends Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange"
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Candidate suggestions. Filtered client-side as the user types. */
  options: RawOption[];
  /** Max suggestions to render (default 8). */
  maxSuggestions?: number;
  /** Fired when a suggestion is explicitly chosen (click / Enter). */
  onSelectOption?: (option: AutocompleteOption) => void;
  /** Minimum characters typed before suggestions appear (default 1). */
  minChars?: number;
  /**
   * Filter `options` client-side against the typed text (default true). Set
   * false when options are already filtered upstream (e.g. a server search),
   * so they render as-is.
   */
  filterOptions?: boolean;
}

/**
 * A free-text input that surfaces a filtered suggestion list once the user
 * has typed. Selecting a suggestion fills the field, but arbitrary text is
 * always allowed — the catalog is a convenience, not a constraint.
 */
const Autocomplete = React.forwardRef<HTMLInputElement, AutocompleteProps>(
  (
    {
      value,
      onValueChange,
      options,
      maxSuggestions = 8,
      onSelectOption,
      minChars = 1,
      filterOptions = true,
      onKeyDown,
      onFocus,
      onBlur,
      className,
      ...inputProps
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const [highlight, setHighlight] = React.useState(0);
    const listId = React.useId();
    const optionId = (i: number) => `${listId}-opt-${i}`;
    // Tracks the blur-close timer so a quick refocus (or unmount) can cancel
    // it before it fires — otherwise a stale timer closes the list or sets
    // state on an unmounted component.
    const blurTimer = React.useRef<number | null>(null);
    const clearBlurTimer = () => {
      if (blurTimer.current !== null) {
        window.clearTimeout(blurTimer.current);
        blurTimer.current = null;
      }
    };
    React.useEffect(() => clearBlurTimer, []);

    const matches = React.useMemo(() => {
      const query = value.trim().toLowerCase();
      if (query.length < minChars) return [];
      const normalized = options.map(normalize);
      // Options already filtered upstream (e.g. a server search): show as-is.
      if (!filterOptions) return normalized.slice(0, maxSuggestions);
      const scored = normalized
        .map((opt) => {
          const hay = `${opt.label ?? opt.value} ${opt.description ?? ""}`
            .trim()
            .toLowerCase();
          const target = (opt.label ?? opt.value).toLowerCase();
          if (target.startsWith(query)) return { opt, score: 0 };
          if (hay.includes(query)) return { opt, score: 1 };
          return null;
        })
        .filter(
          (x): x is { opt: AutocompleteOption; score: number } => x !== null,
        )
        // Hide a lone exact match — there is nothing left to suggest.
        .filter(({ opt }) => (opt.label ?? opt.value).toLowerCase() !== query);
      scored.sort((a, b) => a.score - b.score);
      return scored.slice(0, maxSuggestions).map(({ opt }) => opt);
    }, [value, options, maxSuggestions, minChars, filterOptions]);

    const showList = open && matches.length > 0;

    React.useEffect(() => {
      setHighlight(0);
    }, [value]);

    const choose = (opt: AutocompleteOption) => {
      // Honor the field's maxLength: the value is written programmatically,
      // which bypasses the input's own truncation, so a catalog entry longer
      // than the field allows could otherwise fail server-side validation.
      const max =
        typeof inputProps.maxLength === "number"
          ? inputProps.maxLength
          : undefined;
      onValueChange(max != null ? opt.value.slice(0, max) : opt.value);
      onSelectOption?.(opt);
      clearBlurTimer();
      setOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      if (!showList) {
        if (e.key === "ArrowDown" && matches.length > 0) {
          setOpen(true);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        setHighlight((h) => (h + 1) % matches.length);
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        e.preventDefault();
      } else if (e.key === "Enter") {
        const opt = matches[highlight];
        if (opt) {
          choose(opt);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };

    return (
      <div className="relative">
        <Input
          ref={ref}
          value={value}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList ? optionId(highlight) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          className={className}
          onChange={(e) => {
            onValueChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={(e) => {
            onFocus?.(e);
            clearBlurTimer();
            setOpen(true);
          }}
          onBlur={(e) => {
            onBlur?.(e);
            // Delay so an option's click lands before the list unmounts.
            clearBlurTimer();
            blurTimer.current = window.setTimeout(() => setOpen(false), 120);
          }}
          {...inputProps}
        />
        {showList && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-md"
          >
            {matches.map((opt, i) => (
              <li
                key={`${opt.value}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === highlight}
                // onMouseDown (not onClick) so it fires before input blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(opt);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-1.5 text-sm",
                  i === highlight
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span className="block truncate">{opt.label ?? opt.value}</span>
                {opt.description && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
Autocomplete.displayName = "Autocomplete";

export { Autocomplete };
