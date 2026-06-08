import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DataTable, type Column } from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./Skeleton', () => ({
  Skeleton: ({ variant }: { variant: string }) => <div data-testid={`skeleton-${variant}`} />,
}));

interface Row { id: string; name: string; age: number }

const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: r => r.name },
  { id: 'age', header: 'Age', cell: r => String(r.age), sortable: true },
];

const rows: Row[] = [
  { id: '1', name: 'Alice', age: 30 },
  { id: '2', name: 'Bob', age: 25 },
];

describe('DataTable', () => {
  it('renders rows and columns in the table', () => {
    render(<DataTable rows={rows} columns={columns} getRowId={r => r.id} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Alice')).toBeInTheDocument();
    expect(within(table).getByText('Bob')).toBeInTheDocument();
    expect(within(table).getByText('Name')).toBeInTheDocument();
  });

  it('shows loading skeleton', () => {
    render(<DataTable rows={[]} columns={columns} getRowId={r => r.id} loading />);
    expect(screen.getByTestId('skeleton-table')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    render(<DataTable rows={[]} columns={columns} getRowId={r => r.id} emptyState={<div>No data</div>} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('calls onSortChange when clicking sortable header', () => {
    const onSort = vi.fn();
    render(<DataTable rows={rows} columns={columns} getRowId={r => r.id} onSortChange={onSort} />);
    const table = screen.getByRole('table');
    fireEvent.click(within(table).getByText('Age'));
    expect(onSort).toHaveBeenCalledWith({ id: 'age', dir: 'asc' });
  });

  it('toggles sort direction on second click', () => {
    const onSort = vi.fn();
    render(<DataTable rows={rows} columns={columns} getRowId={r => r.id} onSortChange={onSort} />);
    const table = screen.getByRole('table');
    fireEvent.click(within(table).getByText('Age'));
    fireEvent.click(within(table).getByText('Age'));
    expect(onSort).toHaveBeenLastCalledWith({ id: 'age', dir: 'desc' });
  });

  it('headers have scope=col', () => {
    const { container } = render(<DataTable rows={rows} columns={columns} getRowId={r => r.id} />);
    const ths = container.querySelectorAll('th[scope="col"]');
    expect(ths.length).toBe(2);
  });

  it('sort buttons have type=button', () => {
    const { container } = render(<DataTable rows={rows} columns={columns} getRowId={r => r.id} />);
    const sortBtn = container.querySelector('th button');
    expect(sortBtn?.getAttribute('type')).toBe('button');
  });

  it('renders row actions', () => {
    render(
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={r => r.id}
        rowActions={r => <button>Delete {r.name}</button>}
      />
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('Delete Alice')).toBeInTheDocument();
  });
});
