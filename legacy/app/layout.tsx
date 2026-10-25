import type { Metadata } from "next";
import {
  Playfair_Display,
  Source_Sans_3,
  Plus_Jakarta_Sans,
  Kalam,
  Patrick_Hand,
} from "next/font/google";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/ThemeProvider";
import { type Theme, DEFAULT_THEME, STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const VALID_THEMES: Theme[] = ["luxury", "default", "playful"];

// ── Botanical / Organic Serif ────────────────────────────────────────────────
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

// ── Corporate Trust ──────────────────────────────────────────────────────────
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

// ── Hand-Drawn Playful ───────────────────────────────────────────────────────
const kalam = Kalam({
  variable: "--font-kalam",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const patrickHand = Patrick_Hand({
  variable: "--font-patrick",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Ricotdin — Meeting Assistant",
  description: "Record meetings, get transcripts, summaries, and to-dos.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fontVars = [
    playfair.variable,
    sourceSans.variable,
    jakarta.variable,
    kalam.variable,
    patrickHand.variable,
  ].join(" ");

  // Read the theme from a cookie and apply it to <html data-theme> during SSR.
  // This avoids the first-paint flash with no inline script, and the same value
  // seeds the client ThemeProvider so there's no hydration mismatch.
  const cookieTheme = (await cookies()).get(STORAGE_KEY)?.value;
  const initialTheme: Theme =
    cookieTheme && VALID_THEMES.includes(cookieTheme as Theme)
      ? (cookieTheme as Theme)
      : DEFAULT_THEME;

  return (
    <html lang="en" data-theme={initialTheme} className={fontVars} suppressHydrationWarning>
      <body suppressHydrationWarning>
        {/* Paper grain texture — botanical theme only; hidden via CSS for others */}
        <div
          className="paper-grain pointer-events-none fixed inset-0 z-50 opacity-[0.018]"
          aria-hidden="true"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
            backgroundRepeat: "repeat",
          }}
        />
        <ThemeProvider initialTheme={initialTheme}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
