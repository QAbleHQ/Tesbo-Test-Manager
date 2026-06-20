import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { THEME_STORAGE_KEY } from "@/lib/theme";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tesbo Test Manager",
  description: "AI-Powered Test Case Management",
  icons: {
    icon: "/tesbo-test-manager-logo.png",
    shortcut: "/tesbo-test-manager-logo.png",
    apple: "/tesbo-test-manager-logo.png",
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
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
