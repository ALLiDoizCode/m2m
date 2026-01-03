/**
 * Unit tests for LogViewer component
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { LogViewer } from './LogViewer';
import { LogEntry } from '../types/log';

/**
 * Helper to create mock log entries
 */
function createLogEntry(
  level: 'debug' | 'info' | 'warn' | 'error',
  nodeId: string,
  message: string,
  timestamp?: string,
  correlationId?: string
): LogEntry {
  return {
    level,
    nodeId,
    message,
    timestamp: timestamp || new Date().toISOString(),
    correlationId,
  };
}

describe('LogViewer Component', () => {
  const mockProps = {
    logEntries: [],
    allLogEntries: [],
    autoScroll: true,
    onAutoScrollChange: jest.fn(),
    levelFilter: new Set<string>(),
    toggleLevelFilter: jest.fn(),
    nodeFilter: new Set<string>(),
    toggleNodeFilter: jest.fn(),
    searchText: '',
    setSearchText: jest.fn(),
    clearFilters: jest.fn(),
  };

  describe('Test 9: Table rendering', () => {
    it('should render log entries in table format', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'First message', '2024-12-29T10:00:00Z'),
        createLogEntry('warn', 'connector-b', 'Second message', '2024-12-29T10:01:00Z'),
        createLogEntry('error', 'connector-c', 'Third message', '2024-12-29T10:02:00Z'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
      expect(screen.getByText('Third message')).toBeInTheDocument();
    });

    it('should display timestamp, level, nodeId, and message columns', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Test message', '2024-12-29T10:00:00Z'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      expect(screen.getByText('connector-a')).toBeInTheDocument();
      expect(screen.getByText('Test message')).toBeInTheDocument();
      // Level badge should exist (case may vary)
      expect(screen.getByText(/info/i)).toBeInTheDocument();
    });

    it('should display nodeId in table cell', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Message 1'),
        createLogEntry('info', 'connector-b', 'Message 2'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      expect(screen.getByText('connector-a')).toBeInTheDocument();
      expect(screen.getByText('connector-b')).toBeInTheDocument();
    });

    it('should display correlationId when present', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Packet received', undefined, 'pkt_abc123'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      expect(screen.getByText(/pkt_abc123/)).toBeInTheDocument();
    });

    it('should render table headers', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} />);

      // Assert - Headers should be visible
      expect(screen.getByText('Time')).toBeInTheDocument();
      expect(screen.getByText('Level')).toBeInTheDocument();
      expect(screen.getByText('Node')).toBeInTheDocument();
      expect(screen.getByText('Message')).toBeInTheDocument();
    });

    it('should show "No log entries" when logEntries is empty', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} logEntries={[]} allLogEntries={[]} />);

      // Assert
      expect(screen.getByText('No log entries')).toBeInTheDocument();
    });

    it('should display entry count', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Message 1'),
        createLogEntry('info', 'connector-a', 'Message 2'),
        createLogEntry('info', 'connector-a', 'Message 3'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      expect(screen.getByText('3 entries')).toBeInTheDocument();
    });
  });

  describe('Test 10: Log level badges with correct colors', () => {
    it('should display debug badge with gray color', () => {
      // Arrange
      const logEntries: LogEntry[] = [createLogEntry('debug', 'connector-a', 'Debug message')];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert - Check for debug badge with gray styling
      const badge = screen.getByText(/debug/i);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-gray-700');
      expect(badge.className).toContain('text-gray-300');
    });

    it('should display info badge with blue color', () => {
      // Arrange
      const logEntries: LogEntry[] = [createLogEntry('info', 'connector-a', 'Info message')];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      const badge = screen.getByText(/info/i);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-blue-700');
      expect(badge.className).toContain('text-blue-100');
    });

    it('should display warn badge with yellow color', () => {
      // Arrange
      const logEntries: LogEntry[] = [createLogEntry('warn', 'connector-a', 'Warn message')];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      const badge = screen.getByText(/warn/i);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-yellow-700');
      expect(badge.className).toContain('text-yellow-100');
    });

    it('should display error badge with red color', () => {
      // Arrange
      const logEntries: LogEntry[] = [createLogEntry('error', 'connector-a', 'Error message')];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert
      const badge = screen.getByText(/error/i);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-red-700');
      expect(badge.className).toContain('text-red-100');
    });

    it('should display different badge colors for different levels', () => {
      // Arrange
      const logEntries: LogEntry[] = [
        createLogEntry('debug', 'connector-a', 'Debug'),
        createLogEntry('info', 'connector-a', 'Info'),
        createLogEntry('warn', 'connector-a', 'Warn'),
        createLogEntry('error', 'connector-a', 'Error'),
      ];

      // Act
      render(<LogViewer {...mockProps} logEntries={logEntries} allLogEntries={logEntries} />);

      // Assert - All badges should be rendered with correct colors
      const debugBadge = screen.getByText(/^debug$/i);
      const infoBadge = screen.getByText(/^info$/i);
      const warnBadge = screen.getByText(/^warn$/i);
      const errorBadge = screen.getByText(/^error$/i);

      expect(debugBadge.className).toContain('bg-gray-700');
      expect(infoBadge.className).toContain('bg-blue-700');
      expect(warnBadge.className).toContain('bg-yellow-700');
      expect(errorBadge.className).toContain('bg-red-700');
    });
  });

  describe('Test 11: Auto-scroll behavior', () => {
    it('should display auto-scroll indicator when enabled', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} autoScroll={true} />);

      // Assert
      expect(screen.getByText('Auto-scroll')).toBeInTheDocument();
    });

    it('should not display auto-scroll indicator when disabled', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} autoScroll={false} />);

      // Assert
      expect(screen.queryByText('Auto-scroll')).not.toBeInTheDocument();
    });

    // Note: Testing actual scroll behavior with TableVirtuoso would require
    // more complex testing setup with refs and DOM manipulation.
    // The virtuoso component handles scrolling internally.
  });

  describe('Filter controls', () => {
    it('should render log level filter checkboxes', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} />);

      // Assert - All 4 level checkboxes should exist
      expect(screen.getByText('DEBUG')).toBeInTheDocument();
      expect(screen.getByText('INFO')).toBeInTheDocument();
      expect(screen.getByText('WARN')).toBeInTheDocument();
      expect(screen.getByText('ERROR')).toBeInTheDocument();
    });

    it('should render node ID filter checkboxes based on allLogEntries', () => {
      // Arrange
      const allLogEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Message'),
        createLogEntry('info', 'connector-b', 'Message'),
        createLogEntry('info', 'connector-c', 'Message'),
      ];

      // Act
      render(<LogViewer {...mockProps} allLogEntries={allLogEntries} />);

      // Assert
      expect(screen.getByText('connector-a')).toBeInTheDocument();
      expect(screen.getByText('connector-b')).toBeInTheDocument();
      expect(screen.getByText('connector-c')).toBeInTheDocument();
    });

    it('should call toggleLevelFilter when level checkbox is clicked', () => {
      // Arrange
      const mockToggleLevelFilter = jest.fn();
      render(<LogViewer {...mockProps} toggleLevelFilter={mockToggleLevelFilter} />);

      // Act
      const errorCheckbox = screen.getByLabelText(/error/i);
      fireEvent.click(errorCheckbox);

      // Assert
      expect(mockToggleLevelFilter).toHaveBeenCalledWith('error');
    });

    it('should call toggleNodeFilter when node checkbox is clicked', () => {
      // Arrange
      const mockToggleNodeFilter = jest.fn();
      const allLogEntries: LogEntry[] = [createLogEntry('info', 'connector-a', 'Message')];

      render(
        <LogViewer
          {...mockProps}
          allLogEntries={allLogEntries}
          toggleNodeFilter={mockToggleNodeFilter}
        />
      );

      // Act
      const nodeCheckbox = screen.getByLabelText('connector-a');
      fireEvent.click(nodeCheckbox);

      // Assert
      expect(mockToggleNodeFilter).toHaveBeenCalledWith('connector-a');
    });

    it('should render search input', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} />);

      // Assert
      const searchInput = screen.getByPlaceholderText('Filter by message...');
      expect(searchInput).toBeInTheDocument();
    });

    it('should call setSearchText when typing in search input', () => {
      // Arrange
      const mockSetSearchText = jest.fn();
      render(<LogViewer {...mockProps} setSearchText={mockSetSearchText} />);

      // Act
      const searchInput = screen.getByPlaceholderText('Filter by message...');
      fireEvent.change(searchInput, { target: { value: 'packet' } });

      // Assert
      expect(mockSetSearchText).toHaveBeenCalledWith('packet');
    });

    it('should render Clear button', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} />);

      // Assert
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('should call clearFilters when Clear button is clicked', () => {
      // Arrange
      const mockClearFilters = jest.fn();
      render(
        <LogViewer
          {...mockProps}
          clearFilters={mockClearFilters}
          levelFilter={new Set(['error'])} // Active filter so button is enabled
        />
      );

      // Act
      const clearButton = screen.getByText('Clear');
      fireEvent.click(clearButton);

      // Assert
      expect(mockClearFilters).toHaveBeenCalled();
    });

    it('should disable Clear button when no filters are active', () => {
      // Arrange & Act
      render(
        <LogViewer {...mockProps} levelFilter={new Set()} nodeFilter={new Set()} searchText="" />
      );

      // Assert
      const clearButton = screen.getByText('Clear');
      expect(clearButton).toBeDisabled();
    });

    it('should enable Clear button when level filter is active', () => {
      // Arrange & Act
      render(
        <LogViewer
          {...mockProps}
          levelFilter={new Set(['error'])}
          nodeFilter={new Set()}
          searchText=""
        />
      );

      // Assert
      const clearButton = screen.getByText('Clear');
      expect(clearButton).not.toBeDisabled();
    });

    it('should enable Clear button when node filter is active', () => {
      // Arrange & Act
      render(
        <LogViewer
          {...mockProps}
          levelFilter={new Set()}
          nodeFilter={new Set(['connector-a'])}
          searchText=""
        />
      );

      // Assert
      const clearButton = screen.getByText('Clear');
      expect(clearButton).not.toBeDisabled();
    });

    it('should enable Clear button when search text is present', () => {
      // Arrange & Act
      render(
        <LogViewer
          {...mockProps}
          levelFilter={new Set()}
          nodeFilter={new Set()}
          searchText="packet"
        />
      );

      // Assert
      const clearButton = screen.getByText('Clear');
      expect(clearButton).not.toBeDisabled();
    });
  });

  describe('Checkbox states', () => {
    it('should check level filter checkbox when level is in levelFilter', () => {
      // Arrange
      const levelFilter = new Set(['error', 'warn']);

      // Act
      render(<LogViewer {...mockProps} levelFilter={levelFilter} />);

      // Assert - Radix UI Checkbox uses data-state attribute
      const errorCheckbox = screen.getByLabelText(/error/i);
      const warnCheckbox = screen.getByLabelText(/warn/i);
      const infoCheckbox = screen.getByLabelText(/info/i);

      expect(errorCheckbox).toHaveAttribute('data-state', 'checked');
      expect(warnCheckbox).toHaveAttribute('data-state', 'checked');
      expect(infoCheckbox).toHaveAttribute('data-state', 'unchecked');
    });

    it('should check node filter checkbox when node is in nodeFilter', () => {
      // Arrange
      const nodeFilter = new Set(['connector-a']);
      const allLogEntries: LogEntry[] = [
        createLogEntry('info', 'connector-a', 'Message'),
        createLogEntry('info', 'connector-b', 'Message'),
      ];

      // Act
      render(<LogViewer {...mockProps} nodeFilter={nodeFilter} allLogEntries={allLogEntries} />);

      // Assert - Radix UI Checkbox uses data-state attribute
      const connectorACheckbox = screen.getByLabelText('connector-a');
      const connectorBCheckbox = screen.getByLabelText('connector-b');

      expect(connectorACheckbox).toHaveAttribute('data-state', 'checked');
      expect(connectorBCheckbox).toHaveAttribute('data-state', 'unchecked');
    });
  });

  describe('Component structure', () => {
    it('should render with dark theme styling', () => {
      // Arrange & Act
      const { container } = render(<LogViewer {...mockProps} />);

      // Assert - Check for dark theme classes
      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer.className).toContain('bg-gray-900');
    });

    it('should display "Log Viewer" title', () => {
      // Arrange & Act
      render(<LogViewer {...mockProps} />);

      // Assert
      expect(screen.getByText('Log Viewer')).toBeInTheDocument();
    });
  });
});
