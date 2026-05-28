import type { ReactNode } from "react";
import { Instrument_Serif, JetBrains_Mono, Newsreader } from "next/font/google";
import "./onboarding.css";

const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`onboarding-shell ${instrument.variable} ${newsreader.variable} ${mono.variable}`}>
      {children}
    </div>
  );
}
