declare module 'pg-query-emscripten' {
  export default function PgQuery(): Promise<{
    readonly parse: (sql: string) => {
      readonly parse_tree?: { readonly stmts?: readonly unknown[] };
      readonly error?: { readonly message?: string } | string | null;
      readonly stderr_buffer?: string;
    };
  }>;
}
