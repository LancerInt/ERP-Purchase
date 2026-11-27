import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Pagination from './Pagination';

describe('Pagination (footer / paging)', () => {
  it('renders nothing when there are no rows', () => {
    const { container } = render(
      <Pagination page={1} pageSize={10} total={0} onChange={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the correct "Showing X–Y of N" range on page 1', () => {
    render(<Pagination page={1} pageSize={10} total={37} onChange={() => {}} />);
    // from=1, to=10, total=37
    const text = screen.getByText(/of/).parentElement.textContent.replace(/\s+/g, ' ');
    expect(text).toContain('1–10');
    expect(text).toContain('37');
  });

  it('shows the correct range on a middle page (last partial page)', () => {
    // page 4 of 37 @ 10/page => from=31, to=37
    render(<Pagination page={4} pageSize={10} total={37} onChange={() => {}} />);
    const text = screen.getByText(/of/).parentElement.textContent.replace(/\s+/g, ' ');
    expect(text).toContain('31–37');
  });

  it('renders numbered page buttons and marks the active one', () => {
    render(<Pagination page={2} pageSize={10} total={50} onChange={() => {}} />);
    // 5 pages -> buttons 1..5
    for (const p of ['1', '2', '3', '4', '5']) {
      expect(screen.getByRole('button', { name: p })).toBeInTheDocument();
    }
  });

  it('calls onChange with the clicked page number', () => {
    const onChange = vi.fn();
    render(<Pagination page={1} pageSize={10} total={50} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('prev is disabled on the first page, next works', () => {
    const onChange = vi.fn();
    render(<Pagination page={1} pageSize={10} total={50} onChange={onChange} />);
    const prev = screen.getByRole('button', { name: /previous/i });
    const next = screen.getByRole('button', { name: /next/i });
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('next is disabled on the last page', () => {
    render(<Pagination page={5} pageSize={10} total={50} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});
