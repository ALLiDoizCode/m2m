/**
 * Mock for react-virtuoso TableVirtuoso component
 * Used in tests to avoid virtualization complexity
 */

import React from 'react';

interface TableVirtuosoProps<T> {
  data: T[];
  components?: {
    Table?: React.ComponentType<React.HTMLAttributes<HTMLTableElement>>;
    TableHead?: React.ComponentType;
    TableBody?: React.ComponentType<React.HTMLAttributes<HTMLTableSectionElement>>;
    TableRow?: React.ComponentType<React.HTMLAttributes<HTMLTableRowElement>>;
  };
  fixedHeaderContent?: () => React.ReactElement;
  itemContent?: (index: number, item: T) => React.ReactElement;
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: boolean;
  style?: React.CSSProperties;
}

export interface TableVirtuosoHandle {
  scrollToIndex: (options: { index: number; align?: string; behavior?: string }) => void;
}

// Simple mock that renders all items without virtualization
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TableVirtuoso: any = React.forwardRef(
  <T,>(props: TableVirtuosoProps<T>, ref: React.Ref<TableVirtuosoHandle>) => {
    const { data, components, fixedHeaderContent, itemContent, style } = props;

    // Expose scroll method for tests
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: () => {
        // No-op in tests
      },
    }));

    const Table = components?.Table || 'table';
    const TableBody = components?.TableBody || 'tbody';
    const TableRow = components?.TableRow || 'tr';

    const TableHeadComponent = components?.TableHead;

    return (
      <div style={style} data-testid="table-virtuoso">
        <Table>
          {TableHeadComponent ? <TableHeadComponent /> : fixedHeaderContent?.()}
          <TableBody>
            {data.map((item, index) => (
              <TableRow key={index}>{itemContent?.(index, item)}</TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
);

TableVirtuoso.displayName = 'TableVirtuoso';
