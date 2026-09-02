"use client";

import { IconCheck } from "@tabler/icons-react";
import { AVATAR_COLORS } from "@/lib/avatarColors";
import { PROJECT_ICON_GLYPH_MAX_GRAPHEMES, truncateProjectIconGlyph, validateProjectIconGlyph } from "@/lib/validation";
import { Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

export interface ProjectIconValue {
  color: string | null;
  glyph: string | null;
}

interface ProjectIconPickerProps {
  value: ProjectIconValue;
  onChange: (value: ProjectIconValue) => void;
  /** What the badge falls back to when color/glyph aren't overridden — the deterministic swatch and
   *  first initial the project card already renders without this feature. */
  fallbackColor: string;
  fallbackGlyph: string;
  glyphError?: string;
  onGlyphErrorChange?: (error: string) => void;
  disabled?: boolean;
}

/**
 * Shared by the Create Project modal and Project Settings → General: a palette-restricted color
 * swatch plus an optional custom glyph, previewed as the exact badge the project card renders.
 *
 * The palette is deliberately closed (AVATAR_COLORS, not a free hex input) — every one of those six
 * colors is chosen to clear WCAG AA under the white glyph text; an arbitrary color could not promise
 * that. See lib/avatarColors.ts.
 */
export function ProjectIconPicker({
  value,
  onChange,
  fallbackColor,
  fallbackGlyph,
  glyphError,
  onGlyphErrorChange,
  disabled,
}: ProjectIconPickerProps) {
  const previewColor = value.color || fallbackColor;
  const trimmedGlyph = (value.glyph ?? "").trim();
  const previewGlyph = trimmedGlyph || fallbackGlyph;

  return (
    <Field>
      <FieldLabel>Icon (optional)</FieldLabel>
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
          style={{ background: previewColor }}
          aria-hidden="true"
        >
          {previewGlyph}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Icon color">
            <button
              type="button"
              onClick={() => onChange({ ...value, color: null })}
              disabled={disabled}
              aria-pressed={value.color === null}
              aria-label="Automatic color"
              title="Automatic — derived from the project"
              className={`h-6 w-6 shrink-0 cursor-pointer rounded-full border-2 border-dashed transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                value.color === null ? "border-[var(--brand-primary)]" : "border-[var(--border)]"
              }`}
            />
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onChange({ ...value, color })}
                disabled={disabled}
                aria-pressed={value.color === color}
                aria-label={`Icon color ${color}`}
                title={color}
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--surface)] transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: color, boxShadow: value.color === color ? "0 0 0 2px var(--brand-primary)" : "none" }}
              >
                {value.color === color && <IconCheck size={13} stroke={3} className="text-white" />}
              </button>
            ))}
          </div>
          <Input
            type="text"
            value={value.glyph ?? ""}
            onChange={(e) => {
              // Truncated live, so typing past the limit simply stops adding characters — the same
              // behavior a native maxLength gives, but counted in graphemes so a multi-codepoint
              // emoji (a ZWJ sequence, a skin-tone modifier) still counts as one. Uppercased too —
              // toUpperCase() is a no-op on an emoji or digit, so this only ever affects letters.
              const raw = truncateProjectIconGlyph(e.target.value.replace(/[\r\n\t]/g, "").toUpperCase());
              onChange({ ...value, glyph: raw });
              if (onGlyphErrorChange && glyphError && !validateProjectIconGlyph(raw)) onGlyphErrorChange("");
            }}
            placeholder={fallbackGlyph || "Letter or emoji"}
            maxLength={16}
            disabled={disabled}
            className="max-w-[140px]"
            aria-label="Custom icon letter or emoji"
            aria-invalid={Boolean(glyphError)}
          />
          <FieldHint>
            Optional — {PROJECT_ICON_GLYPH_MAX_GRAPHEMES} characters max, replaces the initial shown on the badge.
          </FieldHint>
          {glyphError && <FieldError>{glyphError}</FieldError>}
        </div>
      </div>
    </Field>
  );
}
