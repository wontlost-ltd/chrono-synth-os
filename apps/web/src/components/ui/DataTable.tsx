import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  width?: string;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  onSortChange?: (sort: { id: string; dir: 'asc' | 'desc' }) => void;
  pagination?: Pagination;
  rowActions?: (row: T) => ReactNode;
  loading?: boolean;
  emptyState?: ReactNode;
}

export function DataTable<T>({ rows, columns, getRowId, onSortChange, pagination, rowActions, loading, emptyState }: DataTableProps<T>) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null);

  const handleSort = (colId: string) => {
    const next = sort?.id === colId && sort.dir === 'asc' ? { id: colId, dir: 'desc' as const } : { id: colId, dir: 'asc' as const };
    setSort(next);
    onSortChange?.(next);
  };

  if (loading) return <Skeleton variant="table" />;

  if (!rows.length && emptyState) {
    return <>{emptyState}</>;
  }

  const alignClass = (a?: string) => a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left';
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 0;

  return (
    <div>
      {/* 桌面端表格 */}
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full text-sm" role="table">
          <thead className="bg-neutral-1 text-text-secondary">
            <tr>
              {columns.map(col => (
                <th
                  key={col.id}
                  scope="col"
                  className={`px-4 py-3 font-medium ${alignClass(col.align)}`}
                  style={col.width ? { width: col.width } : undefined}
                  aria-sort={sort?.id === col.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {col.sortable ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-text-primary" onClick={() => handleSort(col.id)}>
                      {col.header}
                      <span aria-hidden="true" className="text-xs">
                        {sort?.id === col.id ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  ) : col.header}
                </th>
              ))}
              {rowActions && <th scope="col" className="px-4 py-3 text-right font-medium">{t('simulations.colActions')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(row => (
              <tr key={getRowId(row)} className="hover:bg-neutral-1/50">
                {columns.map(col => (
                  <td key={col.id} className={`px-4 py-3 ${alignClass(col.align)}`}>
                    {col.cell ? col.cell(row) : String((row as Record<string, unknown>)[col.id] ?? '')}
                  </td>
                ))}
                {rowActions && <td className="px-4 py-3 text-right">{rowActions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动端卡片 */}
      <div className="space-y-3 md:hidden">
        {rows.map(row => (
          <div key={getRowId(row)} className="rounded-lg border border-border p-4">
            {columns.map(col => (
              <div key={col.id} className="flex justify-between py-1 text-sm">
                <span className="font-medium text-text-secondary">{col.header}</span>
                <span className="text-text-primary">{col.cell ? col.cell(row) : String((row as Record<string, unknown>)[col.id] ?? '')}</span>
              </div>
            ))}
            {rowActions && <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">{rowActions(row)}</div>}
          </div>
        ))}
      </div>

      {/* 分页 */}
      {pagination && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-text-secondary">{t('simulations.pageInfo', { page: pagination.page, total: totalPages })}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onChange(pagination.page - 1)}
              className="rounded border border-border px-3 py-1 hover:bg-surface disabled:opacity-50"
            >
              {t('simulations.prev')}
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onChange(pagination.page + 1)}
              className="rounded border border-border px-3 py-1 hover:bg-surface disabled:opacity-50"
            >
              {t('simulations.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
