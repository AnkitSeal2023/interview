import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import UserMenu from "@/components/UserMenu";
import { AuthProvider } from "@/components/AuthProvider";

export const metadata: Metadata = {
  title: "Role Mock — mock interviews by role",
  description: "AI-powered mock interviews for technical, analytical, and product roles",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans">
        <AuthProvider>
          <header className="site-header sticky top-0 z-20 border-b border-[#1a1a1a] bg-background">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
              <Link
                href="/"
                className="text-[15px] font-semibold tracking-tight text-foreground"
              >
                Role Mock
              </Link>
              <nav className="flex items-center gap-5 text-sm text-muted-foreground">
                <Link href="/" className="hidden hover:text-foreground sm:inline">
                  New interview
                </Link>
                <Link href="/reports" className="hidden hover:text-foreground sm:inline">
                  My sessions
                </Link>
                <span className="hidden h-6 w-px bg-[#1a1a1a] sm:block" aria-hidden="true" />
                <UserMenu />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 pb-16 md:px-6">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
