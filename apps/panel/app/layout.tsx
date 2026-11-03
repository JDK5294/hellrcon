import type { Metadata } from "next";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { APP_NAME } from "../lib/brand";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Hell Let Loose server management panel",
  // An iPhone's home-screen icon (it ignores the manifest's). Without it, it saved a screenshot.
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint to avoid a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* The browser chrome around the page — a phone's status bar, the tab strip — tints to
            match. Without these a dark panel sat under a stark white system bar. The values are
            the two themes' `--bg` tokens, written as literal tags beside the theme script;
            media-based because a meta tag can't follow the in-app theme switch, and the system
            preference is right for everyone who hasn't deliberately crossed their themes. */}
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f7fa" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0c10" />
      </head>
      <body>{children}</body>
    </html>
  );
}
