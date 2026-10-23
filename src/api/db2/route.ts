import { sql } from '@/lib/azureSql';

export type {
  ColumnInfo,
  TableInfo,
  DbConnection,
} from '@/lib/azureSql';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dbId = searchParams.get('db') || 'db2';
    const server = searchParams.get('server') || '';
    const database = searchParams.get('database') || '';
    const userName = searchParams.get('userName') || '';
    const password = searchParams.get('password') || '';

    const config: sql.config = {
      server: server || 'your-server.database.windows.net',
      database: database || 'your-database',
      user: userName || 'your-username',
      password: password || 'your-password',
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
    };

    const pool = await sql.connect(config);
    
    // Fetch all tables
    const tableResult = await sql.query`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_TYPE = 'BASE TABLE'
    `;

    const tables: any[] = [];

    for (const row of tableResult.recordset) {
      const tableName = row.TABLE_NAME;
      
      // Fetch columns for each table
      const columnResult = await sql.query`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = ${tableName}
      `;

      const columns: any[] = columnResult.recordset.map((col: any) => ({
        name: col.COLUMN_NAME,
        dataType: col.DATA_TYPE.toLowerCase(),
        maxLength: col.CHARACTER_MAXIMUM_LENGTH,
        nullable: col.IS_NULLABLE === 'YES',
      }));

      tables.push({
        name: tableName,
        columns,
      });
    }

    await pool.close();
    return new Response(JSON.stringify({ tables, dbId }), { status: 200 });
  } catch (error) {
    console.error('Error fetching tables:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch tables' }), { status: 500 });
  }
}
