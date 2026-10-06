import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentUser } from "@/lib/auth";
import SignOutButton from "./SignOutButton";

export const metadata: Metadata = {
  title: "SplitApp",
  description: "Split group expenses with friends.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1aa57a" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            <span className="logo">÷</span> SplitApp
          </a>
          {me && (
            <div className="row">
              <span className="muted small user-email">{me}</span>
              <SignOutButton />
            </div>
          )}
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
