import type { Metadata } from "next";
import "./globals.css";
import { THEME_STORAGE_KEY } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Tesbo",
  description: "AI-Powered Test Case Management",
  icons: {
    icon: "/tesbox-logo-transparent.png",
    shortcut: "/tesbox-logo-transparent.png",
    apple: "/tesbox-logo-transparent.png",
  },
};

const themeInitScript = `
  (() => {
    try {
      const storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
      const savedTheme = window.localStorage.getItem(storageKey);
      const theme = savedTheme === "dark" ? "dark" : "light";
      const root = document.documentElement;
      root.classList.toggle("dark", theme === "dark");
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    } catch {
      const root = document.documentElement;
      root.classList.remove("dark");
      root.dataset.theme = "light";
      root.style.colorScheme = "light";
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
