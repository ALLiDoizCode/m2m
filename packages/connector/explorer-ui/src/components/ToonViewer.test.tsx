import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToonViewer, hasNostrEvent, NostrEvent } from './ToonViewer';
import { encode as encodeToon } from '@toon-format/toon';

/**
 * Factory function to create test NostrEvent
 */
function createNostrEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: '1'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Test content',
    sig: '2'.repeat(128),
    ...overrides,
  };
}

describe('ToonViewer', () => {
  describe('Kind 1 (Text Note) rendering', () => {
    it('renders Kind 1 with content', () => {
      const event = createNostrEvent({
        kind: 1,
        content: 'Hello, this is a test note!',
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Text Note')).toBeInTheDocument();
      expect(screen.getByText('Hello, this is a test note!')).toBeInTheDocument();
    });

    it('renders Kind 1 with tags', () => {
      const event = createNostrEvent({
        kind: 1,
        content: 'Note with tags',
        tags: [
          ['e', 'referenced-event-id'],
          ['p', 'referenced-pubkey'],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Tags')).toBeInTheDocument();
      expect(screen.getByText(/e:/)).toBeInTheDocument();
      expect(screen.getByText(/p:/)).toBeInTheDocument();
    });
  });

  describe('Kind 3 (Follow List) rendering', () => {
    it('renders Kind 3 with followed pubkeys', () => {
      const event = createNostrEvent({
        kind: 3,
        content: '',
        tags: [
          ['p', 'a'.repeat(64), 'wss://relay.example.com', 'Alice'],
          ['p', 'b'.repeat(64), 'wss://relay.example.com', 'Bob'],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Follow List')).toBeInTheDocument();
      expect(screen.getByText('2 accounts')).toBeInTheDocument();
      expect(screen.getByText('Followed Pubkeys')).toBeInTheDocument();
      expect(screen.getByText('(Alice)')).toBeInTheDocument();
      expect(screen.getByText('(Bob)')).toBeInTheDocument();
    });

    it('renders Kind 3 ILP addresses from tags', () => {
      const event = createNostrEvent({
        kind: 3,
        content: '',
        tags: [
          ['p', 'a'.repeat(64)],
          ['ilp', 'g.example.alice'],
          ['ilp', 'g.example.bob'],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('ILP Addresses')).toBeInTheDocument();
      expect(screen.getByText('g.example.alice')).toBeInTheDocument();
      expect(screen.getByText('g.example.bob')).toBeInTheDocument();
    });

    it('shows correct follow count', () => {
      const event = createNostrEvent({
        kind: 3,
        content: '',
        tags: [
          ['p', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['p', 'c'.repeat(64)],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('3 accounts')).toBeInTheDocument();
    });
  });

  describe('Kind 5 (Delete) rendering', () => {
    it('renders Kind 5 with deleted event IDs', () => {
      const event = createNostrEvent({
        kind: 5,
        content: 'Deleting old posts',
        tags: [
          ['e', 'deleted-event-1'.padEnd(64, '0')],
          ['e', 'deleted-event-2'.padEnd(64, '0')],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.getByText('2 event(s)')).toBeInTheDocument();
      expect(screen.getByText('Event IDs')).toBeInTheDocument();
      expect(screen.getByText('Deleting old posts')).toBeInTheDocument();
    });

    it('shows deleted event count correctly', () => {
      const event = createNostrEvent({
        kind: 5,
        content: '',
        tags: [
          ['e', 'event1'.padEnd(64, '0')],
          ['e', 'event2'.padEnd(64, '0')],
          ['e', 'event3'.padEnd(64, '0')],
        ],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('3 event(s)')).toBeInTheDocument();
    });
  });

  describe('Kind 10000 (Query) rendering', () => {
    it('renders Kind 10000 with parsed filter', () => {
      const filter = {
        kinds: [1],
        authors: ['pubkey123'],
        limit: 10,
      };
      const event = createNostrEvent({
        kind: 10000,
        content: JSON.stringify(filter),
        tags: [],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Query')).toBeInTheDocument();
      expect(screen.getByText('Filter Criteria')).toBeInTheDocument();
      expect(screen.getByText('kinds:')).toBeInTheDocument();
      expect(screen.getByText('[1]')).toBeInTheDocument();
      expect(screen.getByText('authors:')).toBeInTheDocument();
      expect(screen.getByText('limit:')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });

    it('handles non-JSON content in Query', () => {
      const event = createNostrEvent({
        kind: 10000,
        content: 'not-valid-json',
        tags: [],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Query')).toBeInTheDocument();
      expect(screen.getByText('not-valid-json')).toBeInTheDocument();
    });
  });

  describe('unknown kinds rendering', () => {
    it('handles unknown kinds with generic renderer', () => {
      const event = createNostrEvent({
        kind: 999,
        content: 'Unknown event content',
        tags: [['custom', 'tag', 'value']],
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Kind 999')).toBeInTheDocument();
      expect(screen.getByText('Unknown event content')).toBeInTheDocument();
    });

    it('shows collapsible tags for unknown kinds', () => {
      const event = createNostrEvent({
        kind: 999,
        content: 'Content',
        tags: [
          ['tag1', 'value1'],
          ['tag2', 'value2'],
        ],
      });

      render(<ToonViewer data={event} />);

      // Tags should be collapsed initially
      expect(screen.getByText('Tags (2)')).toBeInTheDocument();

      // Click to expand
      fireEvent.click(screen.getByText('Tags (2)'));

      // Now tags should be visible
      expect(screen.getByText(/\["tag1", "value1"\]/)).toBeInTheDocument();
      expect(screen.getByText(/\["tag2", "value2"\]/)).toBeInTheDocument();
    });
  });

  describe('content truncation', () => {
    it('truncates long content with "Show more" button', () => {
      const longContent = 'A'.repeat(600);
      const event = createNostrEvent({
        kind: 1,
        content: longContent,
      });

      render(<ToonViewer data={event} />);

      // Content should be truncated
      expect(screen.queryByText(longContent)).not.toBeInTheDocument();
      expect(screen.getByText('Show more')).toBeInTheDocument();

      // Click to expand
      fireEvent.click(screen.getByText('Show more'));

      // Now full content should be visible
      expect(screen.getByText(longContent)).toBeInTheDocument();
      expect(screen.getByText('Show less')).toBeInTheDocument();

      // Click to collapse
      fireEvent.click(screen.getByText('Show less'));
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    it('does not show "Show more" for short content', () => {
      const event = createNostrEvent({
        kind: 1,
        content: 'Short content',
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Short content')).toBeInTheDocument();
      expect(screen.queryByText('Show more')).not.toBeInTheDocument();
    });
  });

  describe('event metadata display', () => {
    it('displays pubkey (truncated)', () => {
      const event = createNostrEvent({
        pubkey: 'abcd1234' + '0'.repeat(48) + 'efgh5678',
      });

      render(<ToonViewer data={event} />);

      // Should show truncated pubkey format
      expect(screen.getByText('Pubkey')).toBeInTheDocument();
    });

    it('displays created_at timestamp', () => {
      const timestamp = Math.floor(new Date('2024-01-15T10:30:00Z').getTime() / 1000);
      const event = createNostrEvent({
        created_at: timestamp,
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Created At')).toBeInTheDocument();
    });

    it('displays event ID', () => {
      const event = createNostrEvent({
        id: 'eventid' + '0'.repeat(56),
      });

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Event ID')).toBeInTheDocument();
    });

    it('displays signature', () => {
      const event = createNostrEvent();

      render(<ToonViewer data={event} />);

      expect(screen.getByText('Signature')).toBeInTheDocument();
    });

    it('shows invalid signature for test events', () => {
      // Test events have fake signatures that won't verify
      const event = createNostrEvent();

      render(<ToonViewer data={event} />);

      // Test events have invalid signatures (all 2s)
      expect(screen.getByText('Invalid signature')).toBeInTheDocument();
    });
  });

  describe('data format handling', () => {
    it('handles JSON string input', () => {
      const event = createNostrEvent({ kind: 1, content: 'JSON input test' });
      const jsonString = JSON.stringify(event);

      render(<ToonViewer data={jsonString} />);

      expect(screen.getByText('Text Note')).toBeInTheDocument();
      expect(screen.getByText('JSON input test')).toBeInTheDocument();
    });

    it('handles nested event in object', () => {
      const event = createNostrEvent({ kind: 1, content: 'Nested event' });
      const wrappedData = { event };

      render(<ToonViewer data={wrappedData} />);

      expect(screen.getByText('Text Note')).toBeInTheDocument();
      expect(screen.getByText('Nested event')).toBeInTheDocument();
    });

    it('handles nested event in data property', () => {
      const event = createNostrEvent({ kind: 1, content: 'Data nested' });
      const wrappedData = { data: event };

      render(<ToonViewer data={wrappedData} />);

      expect(screen.getByText('Data nested')).toBeInTheDocument();
    });

    it('handles nested event in nostrEvent property', () => {
      const event = createNostrEvent({ kind: 1, content: 'NostrEvent nested' });
      const wrappedData = { nostrEvent: event };

      render(<ToonViewer data={wrappedData} />);

      expect(screen.getByText('NostrEvent nested')).toBeInTheDocument();
    });

    it('shows fallback for undecodable data', () => {
      const invalidData = 'not-json-and-not-toon';

      render(<ToonViewer data={invalidData} />);

      expect(screen.getByText('Unable to decode data as Nostr event.')).toBeInTheDocument();
      expect(screen.getByText(/Raw data preview/)).toBeInTheDocument();
      expect(screen.getByText('not-json-and-not-toon')).toBeInTheDocument();
    });

    it('truncates long raw data preview', () => {
      const longData = 'X'.repeat(600);

      render(<ToonViewer data={longData} />);

      expect(screen.getByText('Unable to decode data as Nostr event.')).toBeInTheDocument();
      // Should show truncated data with ellipsis
      expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument();
    });
  });
});

describe('signature verification', () => {
  it('shows invalid signature for events with fake signatures', () => {
    // Test events have all-2 signatures which are not valid
    const event = createNostrEvent({
      content: 'Event with fake signature',
    });

    render(<ToonViewer data={event} />);

    expect(screen.getByText('Invalid signature')).toBeInTheDocument();
  });

  it('shows invalid signature when signature is wrong length', () => {
    const event = createNostrEvent({
      sig: 'abc', // Too short
    });

    render(<ToonViewer data={event} />);

    expect(screen.getByText('Invalid signature')).toBeInTheDocument();
  });

  it('shows invalid signature when pubkey is wrong length', () => {
    const event = createNostrEvent({
      pubkey: 'abc', // Too short
    });

    render(<ToonViewer data={event} />);

    expect(screen.getByText('Invalid signature')).toBeInTheDocument();
  });

  it('shows invalid signature when id is wrong length', () => {
    const event = createNostrEvent({
      id: 'abc', // Too short
    });

    render(<ToonViewer data={event} />);

    expect(screen.getByText('Invalid signature')).toBeInTheDocument();
  });

  it('shows invalid signature for non-hex id', () => {
    const event = createNostrEvent({
      id: 'g'.repeat(64), // g is not valid hex
    });

    render(<ToonViewer data={event} />);

    expect(screen.getByText('Invalid signature')).toBeInTheDocument();
  });
});

describe('TOON decoding', () => {
  it('decodes valid TOON-formatted NostrEvent', () => {
    // Use the TOON encoder to create valid TOON data
    const event = createNostrEvent({
      kind: 1,
      content: 'Hello from TOON',
      tags: [],
    });
    const toonData = encodeToon(event);

    render(<ToonViewer data={toonData} />);

    expect(screen.getByText('Text Note')).toBeInTheDocument();
    expect(screen.getByText('Hello from TOON')).toBeInTheDocument();
  });

  it('decodes TOON with tags', () => {
    const event = createNostrEvent({
      kind: 1,
      content: 'TOON with tags',
      tags: [
        ['e', 'event123'],
        ['p', 'pubkey456'],
      ],
    });
    const toonData = encodeToon(event);

    render(<ToonViewer data={toonData} />);

    expect(screen.getByText('Text Note')).toBeInTheDocument();
    expect(screen.getByText('TOON with tags')).toBeInTheDocument();
  });

  it('falls back gracefully for invalid TOON data', () => {
    const invalidToon = `id: not-valid
pubkey: also-invalid
kind: text`;

    render(<ToonViewer data={invalidToon} />);

    expect(screen.getByText('Unable to decode data as Nostr event.')).toBeInTheDocument();
  });

  it('shows hex preview for hex data', () => {
    const hexData = 'deadbeef1234567890abcdef';

    render(<ToonViewer data={hexData} />);

    expect(screen.getByText('Hex data preview:')).toBeInTheDocument();
    // Hex should be formatted with spaces
    expect(screen.getByText(/de ad be ef/)).toBeInTheDocument();
  });
});

describe('hasNostrEvent', () => {
  it('correctly identifies valid NostrEvent objects', () => {
    const event = createNostrEvent();
    expect(hasNostrEvent(event)).toBe(true);
  });

  it('correctly identifies valid JSON string events', () => {
    const event = createNostrEvent();
    expect(hasNostrEvent(JSON.stringify(event))).toBe(true);
  });

  it('correctly identifies wrapped events', () => {
    const event = createNostrEvent();
    expect(hasNostrEvent({ event })).toBe(true);
    expect(hasNostrEvent({ data: event })).toBe(true);
    expect(hasNostrEvent({ nostrEvent: event })).toBe(true);
  });

  it('returns false for invalid data', () => {
    expect(hasNostrEvent(null)).toBe(false);
    expect(hasNostrEvent(undefined)).toBe(false);
    expect(hasNostrEvent('not-an-event')).toBe(false);
    expect(hasNostrEvent({})).toBe(false);
    expect(hasNostrEvent({ id: 'partial' })).toBe(false);
  });

  it('returns false for incomplete NostrEvent', () => {
    // Missing required fields
    const incomplete = {
      id: '0'.repeat(64),
      pubkey: '1'.repeat(64),
      // missing created_at, kind, tags, content, sig
    };
    expect(hasNostrEvent(incomplete)).toBe(false);
  });

  it('returns false for wrong types in NostrEvent', () => {
    const wrongTypes = {
      id: 123, // should be string
      pubkey: '1'.repeat(64),
      created_at: Date.now(),
      kind: 1,
      tags: [],
      content: 'test',
      sig: '2'.repeat(128),
    };
    expect(hasNostrEvent(wrongTypes)).toBe(false);
  });
});
