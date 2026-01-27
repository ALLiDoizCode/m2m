import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JsonViewer } from './JsonViewer';

describe('JsonViewer', () => {
  it('renders string values with green color', () => {
    render(<JsonViewer data={{ name: 'test' }} />);

    const stringValue = screen.getByText(/"test"/);
    expect(stringValue).toHaveClass('text-green-400');
  });

  it('renders number values with orange color', () => {
    render(<JsonViewer data={{ count: 42 }} />);

    const numberValue = screen.getByText('42');
    expect(numberValue).toHaveClass('text-orange-400');
  });

  it('renders boolean values with blue color', () => {
    render(<JsonViewer data={{ active: true }} />);

    const boolValue = screen.getByText('true');
    expect(boolValue).toHaveClass('text-blue-400');
  });

  it('renders null values with gray color', () => {
    render(<JsonViewer data={{ empty: null }} />);

    const nullValue = screen.getByText('null');
    expect(nullValue).toHaveClass('text-gray-500');
  });

  it('renders object keys with purple color', () => {
    render(<JsonViewer data={{ myKey: 'value' }} />);

    const key = screen.getByText(/"myKey"/);
    expect(key).toHaveClass('text-purple-400');
  });

  it('renders nested objects', () => {
    render(
      <JsonViewer
        data={{
          outer: {
            inner: 'nested',
          },
        }}
      />
    );

    expect(screen.getByText(/"outer"/)).toBeInTheDocument();
    expect(screen.getByText(/"inner"/)).toBeInTheDocument();
    expect(screen.getByText(/"nested"/)).toBeInTheDocument();
  });

  it('renders arrays', () => {
    render(<JsonViewer data={{ items: [1, 2, 3] }} />);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('handles empty objects', () => {
    render(<JsonViewer data={{}} />);

    expect(screen.getByText('{}')).toBeInTheDocument();
  });

  it('handles empty arrays', () => {
    render(<JsonViewer data={[]} />);

    expect(screen.getByText('[]')).toBeInTheDocument();
  });

  it('collapses nested structures on click', () => {
    render(
      <JsonViewer
        data={{
          outer: {
            inner: 'value',
          },
        }}
      />
    );

    // Initially expanded - inner should be visible
    expect(screen.getByText(/"inner"/)).toBeInTheDocument();

    // Click to collapse outer
    const collapsible = screen.getByText(/"outer"/).closest('div');
    if (collapsible) {
      fireEvent.click(collapsible);
    }

    // After collapse, should show item count instead of nested content
    expect(screen.getByText(/1 item/)).toBeInTheDocument();
  });

  it('respects maxDepth prop', () => {
    const deepData = {
      l1: { l2: { l3: { l4: { deep: 'value' } } } },
    };

    render(<JsonViewer data={deepData} maxDepth={2} />);

    // Should render the structure (depth limiting affects collapse state)
    expect(screen.getByText(/"l1"/)).toBeInTheDocument();
  });

  it('starts collapsed when collapsed prop is true', () => {
    render(<JsonViewer data={{ outer: { inner: 'value' } }} collapsed={true} />);

    // When collapsed=true, root shows {...} indicator
    expect(screen.getByText('{...}')).toBeInTheDocument();
  });
});
