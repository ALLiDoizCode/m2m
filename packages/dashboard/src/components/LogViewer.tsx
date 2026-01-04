/**
 * LogViewer Component - Displays filtered log entries in a table
 * @packageDocumentation
 */

import { useRef, useEffect, useMemo } from 'react';
import { TableVirtuoso, TableVirtuosoHandle } from 'react-virtuoso';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { LogEntry } from '../types/log';

interface LogViewerProps {
  /** Log entries to display */
  logEntries: LogEntry[];
  /** Auto-scroll enabled */
  autoScroll: boolean;
  /** Callback when auto-scroll state should change */
  onAutoScrollChange: (enabled: boolean) => void;
  /** Active log level filters */
  levelFilter: Set<string>;
  /** Toggle log level filter */
  toggleLevelFilter: (level: string) => void;
  /** Active node ID filters */
  nodeFilter: Set<string>;
  /** Toggle node ID filter */
  toggleNodeFilter: (nodeId: string) => void;
  /** Search text for message filtering */
  searchText: string;
  /** Update search text */
  setSearchText: (text: string) => void;
  /** Clear all filters */
  clearFilters: () => void;
  /** All log entries (for deriving unique node IDs) */
  allLogEntries: LogEntry[];
}

/**
 * Format timestamp as relative time (e.g., "2s ago")
 */
function formatRelativeTime(timestamp: string): string {
  const now = new Date();
  const logTime = new Date(timestamp);
  const diffMs = now.getTime() - logTime.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

/**
 * Get badge color class for log level
 */
function getLevelBadgeClass(level: string): string {
  switch (level) {
    case 'debug':
      return 'bg-gray-700 text-gray-300';
    case 'info':
      return 'bg-blue-700 text-blue-100';
    case 'warn':
      return 'bg-yellow-700 text-yellow-100';
    case 'error':
      return 'bg-red-700 text-red-100';
    default:
      return 'bg-gray-700 text-gray-300';
  }
}

/**
 * LogViewer component - Displays log entries in a scrollable table with filters
 *
 * @example
 * ```tsx
 * const { filteredEntries, allLogEntries, levelFilter, nodeFilter, ... } = useLogViewer(events);
 * <LogViewer
 *   logEntries={filteredEntries}
 *   allLogEntries={allLogEntries}
 *   autoScroll={autoScroll}
 *   onAutoScrollChange={toggleAutoScroll}
 *   levelFilter={levelFilter}
 *   toggleLevelFilter={toggleLevelFilter}
 *   nodeFilter={nodeFilter}
 *   toggleNodeFilter={toggleNodeFilter}
 *   searchText={searchText}
 *   setSearchText={setSearchText}
 *   clearFilters={clearFilters}
 * />
 * ```
 */
export function LogViewer({
  logEntries,
  autoScroll,
  onAutoScrollChange,
  levelFilter,
  toggleLevelFilter,
  nodeFilter,
  toggleNodeFilter,
  searchText,
  setSearchText,
  clearFilters,
  allLogEntries,
}: LogViewerProps): JSX.Element {
  const virtuosoRef = useRef<TableVirtuosoHandle>(null);
  const isAtBottomRef = useRef<boolean>(true);

  // Derive unique node IDs from all log entries
  const uniqueNodeIds = useMemo(() => {
    const nodeIds = new Set<string>();
    allLogEntries.forEach((entry) => nodeIds.add(entry.nodeId));
    return Array.from(nodeIds).sort();
  }, [allLogEntries]);

  // Log levels
  const logLevels: Array<'debug' | 'info' | 'warn' | 'error'> = ['debug', 'info', 'warn', 'error'];

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && virtuosoRef.current && logEntries.length > 0) {
      virtuosoRef.current.scrollToIndex({
        index: logEntries.length - 1,
        align: 'end',
        behavior: 'smooth',
      });
    }
  }, [logEntries.length, autoScroll]);

  // Track if user is at bottom
  const handleAtBottomStateChange = (atBottom: boolean): void => {
    isAtBottomRef.current = atBottom;

    // Auto-enable scroll when user scrolls to bottom
    // Auto-disable when user scrolls up
    if (atBottom && !autoScroll) {
      onAutoScrollChange(true);
    } else if (!atBottom && autoScroll) {
      onAutoScrollChange(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 border border-gray-700 rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100">Log Viewer</h2>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span>{logEntries.length} entries</span>
          {autoScroll && (
            <span className="px-2 py-1 bg-green-900 text-green-300 rounded text-xs">
              Auto-scroll
            </span>
          )}
        </div>
      </div>

      {/* Filter Controls */}
      <div className="px-4 py-3 border-b border-gray-700 bg-gray-850">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Log Level Filters */}
          <div>
            <label className="text-xs font-medium text-gray-400 mb-2 block">Log Level</label>
            <div className="flex flex-wrap gap-3">
              {logLevels.map((level) => (
                <div key={level} className="flex items-center gap-2">
                  <Checkbox
                    id={`level-${level}`}
                    checked={levelFilter.has(level)}
                    onCheckedChange={() => toggleLevelFilter(level)}
                  />
                  <label
                    htmlFor={`level-${level}`}
                    className={`text-sm cursor-pointer ${getLevelBadgeClass(level)} px-2 py-1 rounded`}
                  >
                    {level.toUpperCase()}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Node ID Filters */}
          <div>
            <label className="text-xs font-medium text-gray-400 mb-2 block">Node ID</label>
            <div className="flex flex-wrap gap-3">
              {uniqueNodeIds.map((nodeId) => (
                <div key={nodeId} className="flex items-center gap-2">
                  <Checkbox
                    id={`node-${nodeId}`}
                    checked={nodeFilter.has(nodeId)}
                    onCheckedChange={() => toggleNodeFilter(nodeId)}
                  />
                  <label
                    htmlFor={`node-${nodeId}`}
                    className="text-sm text-gray-300 cursor-pointer font-mono"
                  >
                    {nodeId}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Search and Clear */}
          <div>
            <label className="text-xs font-medium text-gray-400 mb-2 block">Search Messages</label>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Filter by message..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="flex-1 bg-gray-800 border-gray-700 text-gray-100"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                disabled={levelFilter.size === 0 && nodeFilter.size === 0 && searchText === ''}
                className="bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700"
              >
                Clear
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Virtualized Table Container */}
      <div className="flex-1 overflow-hidden">
        {logEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            No log entries
          </div>
        ) : (
          <TableVirtuoso
            ref={virtuosoRef}
            data={logEntries}
            atBottomStateChange={handleAtBottomStateChange}
            followOutput={autoScroll}
            style={{ height: '100%' }}
            components={{
              Table: (props) => <Table {...props} className="border-separate border-spacing-0" />,
              TableHead: () => (
                <TableHeader className="sticky top-0 bg-gray-800 z-10">
                  <TableRow>
                    <TableHead className="w-[120px] text-gray-300">Time</TableHead>
                    <TableHead className="w-[80px] text-gray-300">Level</TableHead>
                    <TableHead className="w-[120px] text-gray-300">Node</TableHead>
                    <TableHead className="text-gray-300">Message</TableHead>
                  </TableRow>
                </TableHeader>
              ),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              TableBody: TableBody as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              TableRow: TableRow as any,
            }}
            fixedHeaderContent={() => (
              <TableRow>
                <TableHead className="w-[120px] text-gray-300 bg-gray-800">Time</TableHead>
                <TableHead className="w-[80px] text-gray-300 bg-gray-800">Level</TableHead>
                <TableHead className="w-[120px] text-gray-300 bg-gray-800">Node</TableHead>
                <TableHead className="text-gray-300 bg-gray-800">Message</TableHead>
              </TableRow>
            )}
            itemContent={(_index, entry) => (
              <>
                {/* Timestamp */}
                <TableCell
                  className="font-mono text-xs text-gray-400 border-b border-gray-700"
                  title={entry.timestamp}
                >
                  {formatRelativeTime(entry.timestamp)}
                </TableCell>

                {/* Level Badge */}
                <TableCell className="border-b border-gray-700">
                  <span
                    className={`px-2 py-1 rounded text-xs font-semibold uppercase ${getLevelBadgeClass(
                      entry.level
                    )}`}
                  >
                    {entry.level}
                  </span>
                </TableCell>

                {/* Node ID */}
                <TableCell className="font-mono text-sm text-gray-300 border-b border-gray-700">
                  {entry.nodeId}
                </TableCell>

                {/* Message */}
                <TableCell className="font-mono text-sm text-gray-100 border-b border-gray-700">
                  {entry.message}
                  {entry.correlationId && (
                    <span className="ml-2 text-gray-500 text-xs">[{entry.correlationId}]</span>
                  )}
                </TableCell>
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}
