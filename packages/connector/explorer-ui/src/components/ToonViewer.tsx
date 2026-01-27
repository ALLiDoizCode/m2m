import * as React from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, HelpCircle } from 'lucide-react';
import { decode as decodeToon } from '@toon-format/toon';
import { verifyEvent } from 'nostr-tools/pure';

/**
 * Nostr event structure per NIP-01 specification
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface ToonViewerProps {
  /** TOON-encoded data string or already decoded NostrEvent */
  data: string | NostrEvent | unknown;
}

/**
 * Nostr event kind names
 */
const KIND_NAMES: Record<number, string> = {
  0: 'Metadata',
  1: 'Text Note',
  2: 'Recommend Relay',
  3: 'Follow List',
  4: 'Encrypted DM',
  5: 'Delete',
  6: 'Repost',
  7: 'Reaction',
  10000: 'Query',
  10001: 'Query Response',
};

/**
 * Check if an object looks like a NostrEvent
 */
function isNostrEvent(obj: unknown): obj is NostrEvent {
  if (typeof obj !== 'object' || obj === null) return false;
  const event = obj as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' &&
    typeof event.kind === 'number' &&
    Array.isArray(event.tags) &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string'
  );
}

/**
 * Check if a string looks like TOON format (has key: value lines)
 */
function looksLikeToon(str: string): boolean {
  // TOON format has lines like "key: value" or "key[]:" for arrays
  const lines = str.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;

  // Check if multiple lines match TOON pattern
  const toonLinePattern = /^[\s]*[a-zA-Z_][a-zA-Z0-9_]*(\[\])?:/;
  const matchingLines = lines.filter((l) => toonLinePattern.test(l));
  return matchingLines.length >= 2;
}

/**
 * Try to decode TOON string to NostrEvent
 */
function tryDecodeToon(str: string): NostrEvent | null {
  try {
    const decoded = decodeToon(str);
    if (isNostrEvent(decoded)) {
      return decoded;
    }
  } catch {
    // Not valid TOON
  }
  return null;
}

/**
 * Verify Nostr event signature
 * @returns 'valid' | 'invalid' | 'unknown'
 */
function verifySignature(event: NostrEvent): 'valid' | 'invalid' | 'unknown' {
  // Check if we have the minimum required fields for verification
  if (!event.id || !event.pubkey || !event.sig) {
    return 'unknown';
  }

  // Check if fields have valid hex format (64 chars for id/pubkey, 128 for sig)
  const hexPattern = /^[0-9a-fA-F]+$/;
  if (
    event.id.length !== 64 ||
    event.pubkey.length !== 64 ||
    event.sig.length !== 128 ||
    !hexPattern.test(event.id) ||
    !hexPattern.test(event.pubkey) ||
    !hexPattern.test(event.sig)
  ) {
    return 'invalid';
  }

  try {
    // nostr-tools verifyEvent expects the event to have these exact fields
    const isValid = verifyEvent(event);
    return isValid ? 'valid' : 'invalid';
  } catch {
    // Verification failed (e.g., crypto error)
    return 'invalid';
  }
}

/**
 * Try to extract NostrEvent from various data formats
 */
function extractNostrEvent(data: unknown): NostrEvent | null {
  // Already a NostrEvent
  if (isNostrEvent(data)) {
    return data;
  }

  // String that might be JSON or TOON
  if (typeof data === 'string') {
    // First try JSON parsing
    try {
      const parsed = JSON.parse(data);
      if (isNostrEvent(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON, try TOON if it looks like TOON format
    }

    // Try TOON decoding if it looks like TOON format
    if (looksLikeToon(data)) {
      const toonEvent = tryDecodeToon(data);
      if (toonEvent) {
        return toonEvent;
      }
    }
  }

  // Object with nested event
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    // Check common nested paths
    if (isNostrEvent(obj.event)) return obj.event as NostrEvent;
    if (isNostrEvent(obj.data)) return obj.data as NostrEvent;
    if (isNostrEvent(obj.nostrEvent)) return obj.nostrEvent as NostrEvent;
  }

  return null;
}

/**
 * Format pubkey for display (truncated)
 */
function formatPubkey(pubkey: string): string {
  if (pubkey.length <= 16) return pubkey;
  return pubkey.slice(0, 8) + '...' + pubkey.slice(-8);
}

/**
 * Format timestamp
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Truncatable text component
 */
function TruncatableText({ text, maxLength = 200 }: { text: string; maxLength?: number }) {
  const [expanded, setExpanded] = React.useState(false);

  if (text.length <= maxLength) {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

  return (
    <span>
      <span className="whitespace-pre-wrap">
        {expanded ? text : text.slice(0, maxLength) + '...'}
      </span>
      <button
        onClick={() => setExpanded(!expanded)}
        className="ml-2 text-xs text-blue-400 hover:text-blue-300 underline"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </span>
  );
}

/**
 * Field display component
 */
function Field({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={cn('text-sm break-all', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

/**
 * Render Kind 1 (Text Note)
 */
function TextNoteRenderer({ event }: { event: NostrEvent }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Content" value={<TruncatableText text={event.content} maxLength={500} />} />

      {event.tags.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Tags</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {event.tags.map((tag, i) => (
              <span key={i} className="px-2 py-0.5 bg-muted rounded text-xs font-mono">
                {tag[0]}: {tag.slice(1).join(', ')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Render Kind 3 (Follow List)
 */
function FollowListRenderer({ event }: { event: NostrEvent }) {
  const follows = event.tags.filter((t) => t[0] === 'p');
  const ilpAddresses = event.tags.filter((t) => t[0] === 'ilp');

  return (
    <div className="flex flex-col gap-3">
      <Field label="Following" value={`${follows.length} accounts`} />

      {follows.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">
            Followed Pubkeys
          </span>
          <div className="mt-1 max-h-40 overflow-y-auto">
            {follows.map((tag, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs">
                <span className="font-mono">{formatPubkey(tag[1])}</span>
                {tag[3] && <span className="text-muted-foreground">({tag[3]})</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {ilpAddresses.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">
            ILP Addresses
          </span>
          <div className="mt-1">
            {ilpAddresses.map((tag, i) => (
              <div key={i} className="py-1 text-xs font-mono">
                {tag[1]}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Render Kind 5 (Delete)
 */
function DeleteRenderer({ event }: { event: NostrEvent }) {
  const deletedEvents = event.tags.filter((t) => t[0] === 'e');

  return (
    <div className="flex flex-col gap-3">
      <Field label="Deleted Events" value={`${deletedEvents.length} event(s)`} />

      {deletedEvents.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Event IDs</span>
          <div className="mt-1 max-h-40 overflow-y-auto">
            {deletedEvents.map((tag, i) => (
              <div key={i} className="py-1 text-xs font-mono">
                {formatPubkey(tag[1])}
              </div>
            ))}
          </div>
        </div>
      )}

      {event.content && <Field label="Reason" value={event.content} />}
    </div>
  );
}

/**
 * Render Kind 10000 (Query)
 */
function QueryRenderer({ event }: { event: NostrEvent }) {
  let filter: Record<string, unknown> | null = null;
  try {
    filter = JSON.parse(event.content);
  } catch {
    // Content is not JSON
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Query Type" value="Filter Request" />

      {filter ? (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">
            Filter Criteria
          </span>
          <div className="mt-1 p-2 bg-muted/50 rounded text-xs font-mono">
            {Object.entries(filter).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="text-purple-400">{key}:</span>
                <span>{JSON.stringify(value)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Field label="Content" value={<TruncatableText text={event.content} />} />
      )}
    </div>
  );
}

/**
 * Generic event renderer for unknown kinds
 */
function GenericRenderer({ event }: { event: NostrEvent }) {
  const [showTags, setShowTags] = React.useState(false);

  return (
    <div className="flex flex-col gap-3">
      {event.content && (
        <Field label="Content" value={<TruncatableText text={event.content} maxLength={500} />} />
      )}

      {event.tags.length > 0 && (
        <div>
          <button
            onClick={() => setShowTags(!showTags)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showTags ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Tags ({event.tags.length})
          </button>
          {showTags && (
            <div className="mt-1 p-2 bg-muted/50 rounded text-xs font-mono max-h-40 overflow-y-auto">
              {event.tags.map((tag, i) => (
                <div key={i} className="py-0.5">
                  [{tag.map((t) => JSON.stringify(t)).join(', ')}]
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Signature verification status display
 */
function SignatureStatus({ status }: { status: 'valid' | 'invalid' | 'unknown' }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      {status === 'valid' && (
        <>
          <CheckCircle className="w-3 h-3 text-green-400" />
          <span className="text-green-400">Valid signature</span>
        </>
      )}
      {status === 'invalid' && (
        <>
          <XCircle className="w-3 h-3 text-red-400" />
          <span className="text-red-400">Invalid signature</span>
        </>
      )}
      {status === 'unknown' && (
        <>
          <HelpCircle className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">Signature not verified</span>
        </>
      )}
    </div>
  );
}

/**
 * ToonViewer - Display TOON-encoded Nostr events
 *
 * Renders:
 * - Kind 1 (Text Note): Show content as formatted text
 * - Kind 3 (Follow List): Display followed pubkeys with petnames, ILP addresses
 * - Kind 5 (Delete): Show deleted event IDs
 * - Kind 10000 (Query): Display filter object
 */
export function ToonViewer({ data }: ToonViewerProps) {
  const event = extractNostrEvent(data);

  // Compute signature verification status
  const signatureStatus = React.useMemo(() => {
    if (!event) return 'unknown' as const;
    return verifySignature(event);
  }, [event]);

  if (!event) {
    // Format the preview based on data type
    let preview: string;
    let isHex = false;

    if (typeof data === 'string') {
      // Check if it looks like hex data (all hex chars)
      const hexPattern = /^[0-9a-fA-F]+$/;
      if (hexPattern.test(data.replace(/\s/g, ''))) {
        // Format as hex with spaces every 2 chars
        const cleanHex = data.replace(/\s/g, '');
        preview = cleanHex.match(/.{1,2}/g)?.join(' ') || data;
        isHex = true;
      } else {
        preview = data;
      }
    } else {
      preview = JSON.stringify(data, null, 2);
    }

    const truncated = preview.length > 500;
    const displayPreview = truncated ? preview.slice(0, 500) : preview;

    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p>Unable to decode data as Nostr event.</p>
        <p className="mt-2 text-xs">{isHex ? 'Hex data preview:' : 'Raw data preview:'}</p>
        <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto max-h-40 break-all">
          {displayPreview}
          {truncated && '...'}
        </pre>
      </div>
    );
  }

  const kindName = KIND_NAMES[event.kind] || `Kind ${event.kind}`;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Event Header */}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'px-2 py-1 rounded text-xs font-medium',
            event.kind === 1 && 'bg-blue-500/20 text-blue-400',
            event.kind === 3 && 'bg-purple-500/20 text-purple-400',
            event.kind === 5 && 'bg-red-500/20 text-red-400',
            event.kind === 10000 && 'bg-yellow-500/20 text-yellow-400',
            ![1, 3, 5, 10000].includes(event.kind) && 'bg-gray-500/20 text-gray-400'
          )}
        >
          {kindName}
        </span>
        <SignatureStatus status={signatureStatus} />
      </div>

      {/* Event Metadata */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Pubkey" value={formatPubkey(event.pubkey)} mono />
        <Field label="Created At" value={formatTimestamp(event.created_at)} />
      </div>

      {/* Event ID */}
      <Field label="Event ID" value={formatPubkey(event.id)} mono />

      {/* Kind-specific content */}
      <div className="border-t border-border pt-4">
        {event.kind === 1 && <TextNoteRenderer event={event} />}
        {event.kind === 3 && <FollowListRenderer event={event} />}
        {event.kind === 5 && <DeleteRenderer event={event} />}
        {event.kind === 10000 && <QueryRenderer event={event} />}
        {![1, 3, 5, 10000].includes(event.kind) && <GenericRenderer event={event} />}
      </div>

      {/* Signature */}
      <div className="border-t border-border pt-3">
        <Field
          label="Signature"
          value={<span className="text-xs text-muted-foreground">{formatPubkey(event.sig)}</span>}
          mono
        />
      </div>
    </div>
  );
}

/**
 * Check if data might contain a Nostr event
 */
export function hasNostrEvent(data: unknown): boolean {
  return extractNostrEvent(data) !== null;
}
