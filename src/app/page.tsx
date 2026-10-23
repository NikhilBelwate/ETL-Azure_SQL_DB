import Link from "next/link";
export default function Home() {
  return <div className="mx-auto max-w-7xl space-y-8 p-6 md:p-10">
    <div className="max-w-2xl"><p className="mb-3 text-sm font-medium text-primary">AZURE SQL WORKSPACE</p><h1 className="text-4xl font-semibold tracking-tight">Move from connection to column mapping.</h1><p className="mt-4 text-muted-foreground">Connect two Azure SQL databases, map compatible columns, and preview your transformation queries.</p></div>
    <div className="grid gap-6 md:grid-cols-3">
      {[["01", "Connect to DBs", "Load source and target tables using your database credentials.", "/connect"], ["02", "Column Mapping", "Choose columns, validate types, and define transformations.", "/mapping"], ["03", "Data Loading", "Fetch source records, review mapped values, and confirm insertion into the target.", "/loading"]].map(([step, title, description, href]) => <Link key={href} href={href} className="rounded-xl border border-border p-6 transition-colors hover:border-primary"><p className="text-sm text-primary">{step}</p><h2 className="mt-4 text-xl font-semibold">{title} →</h2><p className="mt-2 text-sm text-muted-foreground">{description}</p></Link>)}
    </div>
    <p className="text-sm text-muted-foreground">Review fetched records before confirming a transactional insert into your target database.</p>
  </div>;
}
