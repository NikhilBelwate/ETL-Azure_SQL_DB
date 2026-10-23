"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
export function Navigation() {
  const pathname = usePathname();
  const [publicIp, setPublicIp] = useState("Loading…");

  useEffect(() => {
    const controller = new AbortController();

    async function loadPublicIp() {
      try {
        const response = await fetch("/api/public-ip", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Public IP lookup failed");
        const data = await response.json();
        if (typeof data.ip !== "string") throw new Error("Invalid public IP response");
        setPublicIp(data.ip);
      } catch {
        if (!controller.signal.aborted) setPublicIp("Unavailable");
      }
    }

    void loadPublicIp();
    return () => controller.abort();
  }, []);

  return <header className="border-b border-border bg-background">
    <nav aria-label="Main navigation" className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
      <Link href="/" className="text-lg font-semibold">ETL Tool</Link>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-muted-foreground" aria-live="polite" title="Public outbound IP of the machine running this app">
          Public IP: <span className="font-mono break-all">{publicIp}</span>
        </span>
        {[["/", "Home"], ["/connect", "Connect to DBs"], ["/mapping", "Mapping"], ["/loading", "Loading"]].map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={pathname === href ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground"}>{label}</Link>)}
      </div>
    </nav>
  </header>;
}
