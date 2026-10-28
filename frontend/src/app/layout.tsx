import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import UserMenu from "@/components/UserMenu";
import { AuthProvider } from "@/components/AuthProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Role Mock Interview",
  description: "AI-powered mock interviews for technical, analytical, and product roles",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable}  min-h-screen `}>
        <AuthProvider>
          <header className="site-header border-b border-border/70 bg-background/80 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
              <Link href="/" className="font-semibold tracking-tight">
                Role<span className="text-neutral-500">·</span>Mock
              </Link>
              <nav className="flex items-center text-sm text-neutral-400">
                <UserMenu />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-2 h-screen">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
