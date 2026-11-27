import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the child components that pull in app-wide hooks/constants, so the test
// focuses on PageHeader's own structure (title, breadcrumb, back, actions).
vi.mock('./BackToModule', () => ({
  default: () => <button aria-label="Back">back</button>,
}));
vi.mock('./CompanyFilter', () => ({ default: () => <div data-testid="company-filter" /> }));
vi.mock('../ui', () => ({
  // Minimal Button that renders a link when `as`/`to` are given (for create-link).
  Button: ({ as: As = 'button', to, children, ...rest }) =>
    As === 'button'
      ? <button {...rest}>{children}</button>
      : <a href={to} {...rest}>{children}</a>,
}));

import PageHeader from './PageHeader';

const renderH = (props) =>
  render(
    <MemoryRouter>
      <PageHeader {...props} />
    </MemoryRouter>
  );

describe('PageHeader (header)', () => {
  it('renders the title and subtitle', () => {
    renderH({ title: 'Purchase Orders', subtitle: 'Manage all purchase orders' });
    expect(screen.getByRole('heading', { name: 'Purchase Orders' })).toBeInTheDocument();
    expect(screen.getByText('Manage all purchase orders')).toBeInTheDocument();
  });

  it('renders breadcrumb crumbs, with links for crumbs that have an href', () => {
    renderH({
      title: 'Orders (PO)',
      breadcrumbs: [{ label: 'Sourcing', href: '/purchase/requests' }, { label: 'Orders (PO)' }],
    });
    // linked crumb -> an <a> that redirects to its href
    const link = screen.getByRole('link', { name: 'Sourcing' });
    expect(link).toHaveAttribute('href', '/purchase/requests');
    // current crumb -> plain text, not a link
    expect(screen.queryByRole('link', { name: 'Orders (PO)' })).toBeNull();
  });

  it('shows a back control', () => {
    renderH({ title: 'Receipts' });
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('create action renders a redirect link to the create route', () => {
    renderH({
      title: 'Purchase Orders',
      actions: { createLink: '/purchase/orders/new', createLabel: 'New PO' },
    });
    const create = screen.getByRole('link', { name: /New PO/i });
    expect(create).toHaveAttribute('href', '/purchase/orders/new');
  });

  it('renders the company filter unless hidden', () => {
    const { rerender } = renderH({ title: 'Bills' });
    expect(screen.getByTestId('company-filter')).toBeInTheDocument();
    rerender(
      <MemoryRouter><PageHeader title="Bills" hideCompanyFilter /></MemoryRouter>
    );
    expect(screen.queryByTestId('company-filter')).toBeNull();
  });

  it('band variant also renders title + breadcrumb redirect link', () => {
    renderH({
      band: true,
      title: 'Purchase Orders',
      breadcrumbs: [{ label: 'Sourcing', href: '/purchase/requests' }, { label: 'Orders (PO)' }],
      actions: { createLink: '/purchase/orders/new', createLabel: 'New PO' },
    });
    expect(screen.getByRole('heading', { name: 'Purchase Orders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sourcing' })).toHaveAttribute('href', '/purchase/requests');
    expect(screen.getByRole('link', { name: /New PO/i })).toHaveAttribute('href', '/purchase/orders/new');
  });
});
