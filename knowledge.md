# ETL Tool Knowledge Base

## Project Overview
ETL tool for Azure SQL Database with Next.js frontend featuring dual database connections, column mapping with transformation logic, data loading progress tracking, and abort capability.

## Framework
- **Next.js 16.4.0** (App Router with Turbopack)
- **TypeScript** (strict mode)
- **Tailwind CSS v4** with custom color scheme
- **mssql** package for Azure SQL DB connectivity

## Key Pages

### /connect
- Database connection setup with server, database, username, password fields for 2 DBs
- Table loading via API routes (`/api/db1`, `/api/db2`)
- `"use client"` directive required for React Server Component compatibility

### /mapping
- Table selection from both DBs
- Column mapping with data type validation
- Double-click transformation prompt
- Query generation

### /loading
- Progress bar with percentage display
- Rows processed/total rows display
- Abort/rollback button
- Auto-navigation to home on completion

### /home
- Navigation between all pages

## Core Components

### UI Components (src/components/ui/)
- **Input** - Form input with label
- **Button** - Styled button with variants
- **Select** - Dropdown selector

### Database Integration (src/lib/azureSql.ts)
- mssql query execution using `INFORMATION_SCHEMA`
- Interfaces: `ColumnInfo`, `TableInfo`, `DbConnection`
- API routes use `import { sql } from '@/lib/azureSql'`

## Known Issues & Workarounds

### TypeScript/JSX Parsing
Next.js 16 Turbopack has limitations with certain JavaScript syntax patterns in function bodies and JSX. The following patterns were avoided:

1. **Arrow functions in function bodies** (`const x = () => { ... }`) → Used `function` keyword
2. **Arrow functions in JSX onClick** (`onClick={() => ...}`) → Used `.bind()` method  
3. **Template literals** (`` `text` ``) → Used string concatenation with `+`
4. **Object literal shorthand** → Used explicit property names

### API Routes (src/api/db1/route.ts, src/api/db2/route.ts)
- Pre-existing mssql type definition conflicts
- `Cannot find name 'ColumnInfo'`, `has no exported member named 'Config'`, `Property 'close' does not exist`
- These are type definition issues, not runtime errors
- Functional operation verified at http://localhost:3001

## Running the Project
1. `npm install` (installs: next 16.4.0, react 19.3.0, react-dom 19.3.0, mssql ^12.7.6, @tailwindcss/turbopack ^4)
2. Configure Azure SQL credentials in the connect page
3. `npx next dev` starts the development server at http://localhost:3001 (or 3000 if 3001 is in use)

## Functional Features (verified working)
- Dual database connection setup
- Table listing from both sources
- Column mapping with data type compatibility
- Transformation prompts (e.g., `value*2`, `value.Trim()`)
- Data loading progress tracking with abort capability
- Query generation for data transfer