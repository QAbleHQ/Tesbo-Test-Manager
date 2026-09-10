"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { cx } from "@/components/ui/cx";
import {
  DIAL_CODE_COUNTRIES as COUNTRIES,
  DEFAULT_DIAL_CODE_COUNTRY as DEFAULT_COUNTRY,
  findCountryByDialCode,
  type DialCodeCountry as Country,
} from "@/lib/phone-dial-codes";

export interface PhoneInputProps {
  id?: string;
  /** Full value including the leading "+" and dial code, e.g. "+14155551234". Empty string when unset. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  autoComplete?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

/** Digits typed after the country's dial code — everything in `value` past the matched prefix. */
function nationalDigitsOf(value: string, country: Country): string {
  return value.startsWith(country.dialCode) ? value.slice(country.dialCode.length) : value.replace(/^\+/, "");
}

export default function PhoneInput({
  id,
  value,
  onChange,
  placeholder = "4155551234",
  disabled,
  maxLength,
  autoComplete = "tel",
  "aria-invalid": ariaInvalid,
  className,
}: PhoneInputProps) {
  const [country, setCountry] = useState<Country>(() => findCountryByDialCode(value) ?? DEFAULT_COUNTRY);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Stay in sync when `value` changes from outside (a form reset, prefilling from the current user).
  useEffect(() => {
    const matched = findCountryByDialCode(value);
    if (matched && matched.iso2 !== country.iso2) setCountry(matched);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const nationalDigits = nationalDigitsOf(value, country);
  const maxNationalDigits = maxLength ? Math.max(0, maxLength - country.dialCode.length) : undefined;

  function selectCountry(next: Country) {
    setCountry(next);
    setOpen(false);
    setQuery("");
    onChange(nationalDigits ? `${next.dialCode}${nationalDigits}` : "");
  }

  function handleDigitsChange(e: ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, "");
    onChange(digits ? `${country.dialCode}${digits}` : "");
  }

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? COUNTRIES.filter(
        (c) => c.name.toLowerCase().includes(trimmedQuery) || c.dialCode.includes(trimmedQuery.replace(/^\+/, "")),
      )
    : COUNTRIES;

  return (
    <div ref={containerRef} className={cx("relative flex", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Country code: ${country.name} ${country.dialCode}`}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-l-[var(--radius-control)] border border-r-0 border-[var(--border)] bg-[var(--surface)] px-2.5 text-[14px] text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="text-base leading-none">{country.flag}</span>
        <span className="text-[var(--muted)]">{country.dialCode}</span>
        <IconChevronDown size={14} stroke={1.75} className={cx("text-[var(--ink-300)] transition-transform", open && "rotate-180")} />
      </button>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete={autoComplete}
        value={nationalDigits}
        onChange={handleDigitsChange}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxNationalDigits}
        aria-invalid={ariaInvalid}
        className={cx(
          "h-9 w-full min-w-0 rounded-r-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)] placeholder:text-[var(--ink-300)]",
          "transition-[border-color,box-shadow,background-color] duration-150",
          "focus:border-[var(--denim-200)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--denim-200)_22%,transparent)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      />
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-72 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="border-b border-[var(--border)] p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search country or code"
              className="h-8 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--foreground)] placeholder:text-[var(--ink-300)] focus:border-[var(--denim-200)] focus:outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-[var(--muted)]">No countries found</li>
            ) : (
              filtered.map((c) => (
                <li key={c.iso2}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={c.iso2 === country.iso2}
                    onClick={() => selectCountry(c)}
                    className={cx(
                      "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--surface-secondary)]",
                      c.iso2 === country.iso2 ? "bg-[var(--surface-secondary)] text-[var(--brand-primary)]" : "text-[var(--foreground)]",
                    )}
                  >
                    <span className="text-base leading-none">{c.flag}</span>
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="text-[var(--muted)]">{c.dialCode}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
