import { PrismaPg } from "@prisma/adapter-pg";
import { RDS_CA } from "./rds-ca";

// Adapter for the app's Aurora PostgreSQL DB (ROUND_DB_URL). Verifies the server
// cert against the Amazon RDS CA — full TLS auth, not just encryption. Node's
// default trust store doesn't include the RDS CA, so we supply it here.
export function roundDbAdapter(): PrismaPg {
  const raw = process.env.ROUND_DB_URL;
  if (!raw) throw new Error("ROUND_DB_URL is required");
  // Strip sslmode: when it's in the URL, node-postgres uses the URL's SSL config
  // (which carries no CA) and ignores the explicit `ssl` object below. We supply
  // the RDS CA here for full verify-full TLS, so remove sslmode to let it win.
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  return new PrismaPg({
    connectionString: url.toString(),
    ssl: { ca: RDS_CA, rejectUnauthorized: true },
  });
}
