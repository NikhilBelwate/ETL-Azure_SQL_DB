import Link from "next/link";
import { DatabasePanel } from "@/components/database-panel";
import { ConnectionMappings } from "@/components/connection-mappings";

export default function ConnectPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="text-3xl font-semibold">ETL Connection Setup</h1>
        <p className="mt-2 text-muted-foreground">Enter a full connection string or individual connection details for each Azure SQL database.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <DatabasePanel id="db1" />
        <DatabasePanel id="db2" />
      </div>
      <ConnectionMappings />
      <Link href="/mapping" className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Continue to Mapping →</Link>
    </div>
  );
}
