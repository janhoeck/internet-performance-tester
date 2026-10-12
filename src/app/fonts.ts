import { IBM_Plex_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";

/* Variable Fonts, nur "latin" (enthält ä ö ü ß – € – − …). Next lädt sie beim Build
   und hostet sie selbst: im Browser gehen keine Anfragen an Google.
   Achtung Glyphen: → ≥ ≤ ≈ Δ ▲ liegen NICHT im latin-Subset – im UI Icons/Wörter nutzen. */

export const fontDisplay = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  axes: ["wdth"], // schmale Schnitte für lange Komposita (font-stretch 75–100 %)
  variable: "--font-plex-sans",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const fontVariables = `${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`;
