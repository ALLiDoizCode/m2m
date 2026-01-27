import * as React from 'react';
import { cn } from '@/lib/utils';
import { Copy, Check } from 'lucide-react';
import { formatRelativeTime } from '@/lib/event-types';

/**
 * Base field props
 */
interface BaseFieldProps {
  label: string;
  className?: string;
}

/**
 * HexField - Display hex values with truncation and copy
 */
export function HexField({
  label,
  value,
  maxLength = 32,
  className,
  onCopy,
}: BaseFieldProps & {
  value: string;
  maxLength?: number;
  onCopy?: (value: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const shouldTruncate = value.length > maxLength;
  const displayValue =
    expanded || !shouldTruncate
      ? value
      : value.slice(0, maxLength / 2) + '...' + value.slice(-maxLength / 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'font-mono text-xs break-all',
            shouldTruncate && 'cursor-pointer hover:text-blue-400'
          )}
          onClick={shouldTruncate ? () => setExpanded(!expanded) : undefined}
          title={shouldTruncate ? (expanded ? 'Click to collapse' : 'Click to expand') : undefined}
        >
          {displayValue}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * TimestampField - Display timestamps with relative and absolute time
 */
export function TimestampField({
  label,
  value,
  className,
}: BaseFieldProps & {
  value: number | string | Date;
}) {
  const timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? new Date(value).getTime()
        : value.getTime();

  const absoluteTime = new Date(timestamp).toLocaleString();
  const relativeTime = formatRelativeTime(timestamp);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div className="flex flex-col">
        <span className="text-sm">{absoluteTime}</span>
        <span className="text-xs text-muted-foreground">{relativeTime}</span>
      </div>
    </div>
  );
}

/**
 * AmountField - Display amounts with human-readable formatting
 */
export function AmountField({
  label,
  value,
  unit = 'units',
  className,
}: BaseFieldProps & {
  value: string | number | bigint;
  unit?: string;
}) {
  let formattedValue: string;
  try {
    const num = BigInt(String(value));
    formattedValue = num.toLocaleString();
  } catch {
    formattedValue = String(value);
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-sm font-mono">
        {formattedValue} <span className="text-muted-foreground">{unit}</span>
      </span>
    </div>
  );
}

/**
 * Get Explorer URL for a peer ID or ILP address
 * Maps peer IDs like "peer-0" or ILP addresses like "g.agent.peer-0"
 * to their Explorer ports
 */
function getPeerExplorerUrl(address: string): string | null {
  // Try to extract peer index from ILP address (e.g., "g.agent.peer-0" -> 0)
  // or peer ID (e.g., "peer-0" -> 0)
  const peerMatch = address.match(/peer-(\d+)/i);
  if (peerMatch) {
    const peerIndex = parseInt(peerMatch[1], 10);
    const explorerPort = 9100 + peerIndex;
    const currentHost = window.location.hostname;
    return `http://${currentHost}:${explorerPort}`;
  }

  // Also handle agent-0, agent-1 patterns
  const agentMatch = address.match(/agent-(\d+)/i);
  if (agentMatch) {
    const agentIndex = parseInt(agentMatch[1], 10);
    const explorerPort = 9100 + agentIndex;
    const currentHost = window.location.hostname;
    return `http://${currentHost}:${explorerPort}`;
  }

  return null;
}

/**
 * PeerField - Display peer ID with clickable link to their Explorer
 */
export function PeerField({
  label,
  value,
  className,
  onCopy,
}: BaseFieldProps & {
  value: string;
  onCopy?: (value: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const explorerUrl = getPeerExplorerUrl(value);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed
    }
  };

  const handleOpenExplorer = () => {
    if (explorerUrl) {
      window.open(explorerUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        {explorerUrl ? (
          <button
            onClick={handleOpenExplorer}
            className="font-mono text-sm text-blue-500 hover:text-blue-700 hover:underline focus:outline-none"
            title={`Open ${value} Explorer (${explorerUrl})`}
          >
            {value}
          </button>
        ) : (
          <span className="font-mono text-sm break-all">{value}</span>
        )}
        <button
          onClick={handleCopy}
          className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * AddressField - Display ILP addresses with copy button
 */
export function AddressField({
  label,
  value,
  className,
  onCopy,
}: BaseFieldProps & {
  value: string;
  onCopy?: (value: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm break-all">{value}</span>
        <button
          onClick={handleCopy}
          className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * PublicKeyField - Display Nostr pubkeys (truncated with copy)
 */
export function PublicKeyField({
  label,
  value,
  className,
  onCopy,
}: BaseFieldProps & {
  value: string;
  onCopy?: (value: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  // Truncate to show first 8 and last 8 characters
  const truncated = value.length > 20 ? value.slice(0, 8) + '...' + value.slice(-8) : value;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'font-mono text-sm break-all',
            value.length > 20 && 'cursor-pointer hover:text-blue-400'
          )}
          onClick={() => value.length > 20 && setExpanded(!expanded)}
          title={
            value.length > 20 ? (expanded ? 'Click to collapse' : 'Click to expand') : undefined
          }
        >
          {expanded ? value : truncated}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Generic Field display
 */
export function Field({
  label,
  value,
  mono = false,
  className,
}: BaseFieldProps & {
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={cn('text-sm', mono && 'font-mono break-all')}>{value}</span>
    </div>
  );
}

/**
 * CopyButton - Standalone copy button
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
  onCopy,
}: {
  value: string;
  label?: string;
  className?: string;
  onCopy?: (value: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 rounded text-xs',
        'hover:bg-muted transition-colors',
        copied && 'text-green-400',
        className
      )}
      title={`Copy ${label}`}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          {label}
        </>
      )}
    </button>
  );
}
