"use client";

import { useEffect, useState } from "react";
import { getBranding } from "@/lib/api";
import { DEFAULT_LOGO_URL, DEFAULT_PRODUCT_NAME, isBuiltInLogo } from "@/lib/branding";

type BrandLogoProps = {
  className?: string;
  alt?: string;
  decorative?: boolean;
};

export function BrandLogo({ className = "h-10 w-auto object-contain", alt, decorative = false }: BrandLogoProps) {
  const [branding, setBranding] = useState({ productName: DEFAULT_PRODUCT_NAME, logoUrl: DEFAULT_LOGO_URL });

  useEffect(() => {
    let alive = true;
    getBranding()
      .then((next) => {
        if (alive) setBranding(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const label = decorative ? undefined : alt || branding.productName || DEFAULT_PRODUCT_NAME;

  // The built-in lockup is drawn as a background image so the light/dark variant
  // is picked by CSS — no theme state to hydrate, and only one file is fetched.
  if (isBuiltInLogo(branding.logoUrl)) {
    return (
      <span
        className={`tesbo-brand-logo ${className}`}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      />
    );
  }

  return <img src={branding.logoUrl} alt={label ?? ""} className={className} />;
}
