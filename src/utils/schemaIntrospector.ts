import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let schemaCache: string | null = null;

export async function getDatabaseSchema(
  forceRefresh: boolean = false
): Promise<string> {
  if (schemaCache && !forceRefresh) {
    return schemaCache;
  }

  // --- Step 1: Get Tables ---
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema';
  `;

  let schemaDescription = "";

  for (const table of tables) {
    if (table.tablename === "_prisma_migrations") continue;

    schemaDescription += `Table "${table.tablename}":\n`;

    const columns = await prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        constraint_type: string | null;
      }>
    >`
      SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          tc.constraint_type
      FROM
          information_schema.columns AS c
      LEFT JOIN
          information_schema.key_column_usage AS kcu ON c.column_name = kcu.column_name AND c.table_name = kcu.table_name
      LEFT JOIN
          information_schema.table_constraints AS tc ON kcu.constraint_name = tc.constraint_name
      WHERE
          c.table_name = ${table.tablename};
    `;

    for (const c of columns) {
      let constraints = [];
      if (c.constraint_type === "PRIMARY KEY") constraints.push("PRIMARY KEY");
      if (c.constraint_type === "UNIQUE") constraints.push("UNIQUE");
      if (c.is_nullable === "NO") constraints.push("NOT NULL");

      const constraintsString =
        constraints.length > 0 ? ` (${constraints.join(", ")})` : "";
      schemaDescription += `  - ${c.column_name} (${c.data_type})${constraintsString}\n`;
    }

    // --- Step 3: Get Foreign Key Relationships ---
    const foreignKeys = await prisma.$queryRaw<
      Array<{
        fk_column: string;
        target_table: string;
        target_column: string;
      }>
    >`
      SELECT
          kcu.column_name as fk_column,
          ccu.table_name AS target_table,
          ccu.column_name AS target_column
      FROM 
          information_schema.table_constraints AS tc 
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${table.tablename};
    `;

    if (foreignKeys.length > 0) {
      schemaDescription += `  Relationships:\n`;
      foreignKeys.forEach((fk) => {
        schemaDescription += `    - "${fk.fk_column}" references "${fk.target_table}"("${fk.target_column}")\n`;
      });
    }

    const enums = await prisma.$queryRaw<
      Array<{ type_name: string; enum_values: string[] }>
    >`
      SELECT
          t.typname as type_name,
          array_agg(e.enumlabel) as enum_values
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid  
      WHERE t.typtype = 'e' AND t.typname IN (
        SELECT data_type FROM information_schema.columns WHERE table_name = ${table.tablename}
      )
      GROUP BY t.typname;
    `;

    if (enums.length > 0) {
      schemaDescription += `  Enum Types:\n`;
      enums.forEach((en) => {
        schemaDescription += `    - ${en.type_name}: [${en.enum_values
          .map((v) => `'${v}'`)
          .join(", ")}]\n`;
      });
    }

    schemaDescription += "\n";
  }

  schemaCache = schemaDescription;
  return schemaDescription;
}
