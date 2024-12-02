declare module 'node:sqlite' {
    // Type conversion between JavaScript and SQLite data types
    export type SQLiteDataTypes = {
        NULL: null
        INTEGER: number | BigInt
        REAL: number
        TEXT: string
        BLOB: Uint8Array
    }

    // Class representing a SQLite Database connection
    export class DatabaseSync {
      constructor(location: string, options?: DatabaseOptions)

      close(): void // Closes the database connection
      exec(sql: string): void // Executes one or more SQL statements
      open(): void // Opens the database
      prepare(sql: string): StatementSync // Compiles SQL into a prepared statement
    }

    // Options for DatabaseSync
    export interface DatabaseOptions {
        open?: boolean // Default is true, open on constructor
    }

    // Class representing a prepared statement
    export class StatementSync {
      all(namedParameters?: Record<string, any>, ...anonymousParameters: any[]): Record<string, any>[]
      expandedSQL(): string // Returns SQL with parameters replaced
      get(namedParameters?: Record<string, any>, ...anonymousParameters: any[]): Record<string, any> | undefined
      run(namedParameters?: Record<string, any>, ...anonymousParameters: any[]): RunResult
      setAllowBareNamedParameters(enabled: boolean): void // Enable/disable bare named parameters
      setReadBigInts(enabled: boolean): void // Enable/disable reading INTEGER as BigInt
      sourceSQL(): string // Returns the source SQL of the prepared statement
    }

    // Result returned from running a prepared statement
    export interface RunResult {
        changes: number | BigInt // Rows modified, inserted, or deleted
        lastInsertRowid: number | BigInt // Last inserted row ID
    }
}
