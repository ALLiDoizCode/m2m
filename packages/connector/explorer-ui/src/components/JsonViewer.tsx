import * as React from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface JsonViewerProps {
  data: unknown;
  collapsed?: boolean;
  maxDepth?: number;
}

interface JsonNodeProps {
  value: unknown;
  keyName?: string;
  depth: number;
  maxDepth: number;
  isLast: boolean;
}

/**
 * Get the type of a JSON value for styling
 */
function getValueType(
  value: unknown
): 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'string' | 'number' | 'boolean' | 'object';
}

/**
 * Color classes for different value types
 */
const VALUE_COLORS: Record<string, string> = {
  string: 'text-green-400',
  number: 'text-orange-400',
  boolean: 'text-blue-400',
  null: 'text-gray-500',
  key: 'text-purple-400',
};

/**
 * Render a primitive value with syntax highlighting
 */
function PrimitiveValue({ value }: { value: unknown }) {
  const type = getValueType(value);

  if (type === 'string') {
    return <span className={VALUE_COLORS.string}>"{String(value)}"</span>;
  }
  if (type === 'number') {
    return <span className={VALUE_COLORS.number}>{String(value)}</span>;
  }
  if (type === 'boolean') {
    return <span className={VALUE_COLORS.boolean}>{String(value)}</span>;
  }
  if (type === 'null') {
    return <span className={VALUE_COLORS.null}>null</span>;
  }
  return <span>{String(value)}</span>;
}

/**
 * Recursive JSON node renderer
 */
function JsonNode({ value, keyName, depth, maxDepth, isLast }: JsonNodeProps) {
  const [isCollapsed, setIsCollapsed] = React.useState(depth >= 2);
  const type = getValueType(value);
  const isExpandable = type === 'object' || type === 'array';

  // Handle max depth
  if (depth > maxDepth && isExpandable) {
    return (
      <div className="flex items-start">
        {keyName !== undefined && (
          <>
            <span className={VALUE_COLORS.key}>"{keyName}"</span>
            <span className="text-gray-400">: </span>
          </>
        )}
        <span className="text-gray-500 italic">{type === 'array' ? '[...]' : '{...}'}</span>
        {!isLast && <span className="text-gray-400">,</span>}
      </div>
    );
  }

  // Primitive values
  if (!isExpandable) {
    return (
      <div className="flex items-start">
        {keyName !== undefined && (
          <>
            <span className={VALUE_COLORS.key}>"{keyName}"</span>
            <span className="text-gray-400">: </span>
          </>
        )}
        <PrimitiveValue value={value} />
        {!isLast && <span className="text-gray-400">,</span>}
      </div>
    );
  }

  // Arrays and objects
  const entries =
    type === 'array'
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);

  const isEmpty = entries.length === 0;
  const brackets = type === 'array' ? ['[', ']'] : ['{', '}'];

  if (isEmpty) {
    return (
      <div className="flex items-start">
        {keyName !== undefined && (
          <>
            <span className={VALUE_COLORS.key}>"{keyName}"</span>
            <span className="text-gray-400">: </span>
          </>
        )}
        <span className="text-gray-400">{brackets.join('')}</span>
        {!isLast && <span className="text-gray-400">,</span>}
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex items-start cursor-pointer hover:bg-muted/50 -ml-5 pl-5"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="w-4 h-4 flex items-center justify-center shrink-0 mr-1">
          {isCollapsed ? (
            <ChevronRight className="w-3 h-3 text-gray-500" />
          ) : (
            <ChevronDown className="w-3 h-3 text-gray-500" />
          )}
        </span>
        {keyName !== undefined && (
          <>
            <span className={VALUE_COLORS.key}>"{keyName}"</span>
            <span className="text-gray-400">: </span>
          </>
        )}
        <span className="text-gray-400">{brackets[0]}</span>
        {isCollapsed && (
          <>
            <span className="text-gray-500 italic mx-1">
              {entries.length} {entries.length === 1 ? 'item' : 'items'}
            </span>
            <span className="text-gray-400">{brackets[1]}</span>
            {!isLast && <span className="text-gray-400">,</span>}
          </>
        )}
      </div>
      {!isCollapsed && (
        <>
          <div className="ml-4 border-l border-gray-700 pl-2">
            {entries.map(([key, val], index) => (
              <JsonNode
                key={key}
                value={val}
                keyName={type === 'object' ? key : undefined}
                depth={depth + 1}
                maxDepth={maxDepth}
                isLast={index === entries.length - 1}
              />
            ))}
          </div>
          <div className="flex items-start">
            <span className="w-4" />
            <span className="text-gray-400">{brackets[1]}</span>
            {!isLast && <span className="text-gray-400">,</span>}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * JsonViewer - Syntax-highlighted JSON display with collapsible nested structures
 *
 * Color scheme:
 * - Strings: Green
 * - Numbers: Orange
 * - Booleans: Blue
 * - Null: Gray
 * - Keys: Purple
 */
export function JsonViewer({ data, collapsed = false, maxDepth = 5 }: JsonViewerProps) {
  const [initialCollapse] = React.useState(collapsed);

  return (
    <div
      className={cn(
        'font-mono text-xs leading-relaxed overflow-x-auto',
        'bg-muted/30 rounded-md p-4'
      )}
    >
      <JsonNode
        value={data}
        depth={initialCollapse ? maxDepth + 1 : 0}
        maxDepth={maxDepth}
        isLast={true}
      />
    </div>
  );
}
