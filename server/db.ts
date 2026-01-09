import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

const STORAGE_MODE = process.env.STORAGE_MODE || "local";

// 로컬 모드에서는 PostgreSQL 연결 불필요
if (STORAGE_MODE !== "local" && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = process.env.DATABASE_URL 
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null as any;
  
export const db = pool ? drizzle(pool, { schema }) : null as any;
