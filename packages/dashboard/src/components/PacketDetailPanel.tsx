/**
 * Packet Detail Panel Component
 * Displays detailed packet information in a slide-in side panel using shadcn-ui Sheet
 */

import { useState } from 'react';
import { PacketDetail, formatHex, truncateHex } from '@/types/packet';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

interface PacketDetailPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packet: PacketDetail | null;
  recentPacketIds?: string[];
  onSelectPacket?: (packetId: string) => void;
}

export function PacketDetailPanel({
  open,
  onOpenChange,
  packet,
  recentPacketIds = [],
  onSelectPacket,
}: PacketDetailPanelProps): JSX.Element {
  const { toast } = useToast();
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());

  // Copy to clipboard helper
  const copyToClipboard = (text: string, label: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        toast({
          title: 'Copied to clipboard!',
          description: `${label} has been copied.`,
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Failed to copy to clipboard:', err);
        toast({
          title: 'Copy failed',
          description: 'Could not copy to clipboard.',
          variant: 'destructive',
        });
      });
  };

  // Toggle field expansion
  const toggleExpanded = (field: string): void => {
    setExpandedFields((prev) => {
      const updated = new Set(prev);
      if (updated.has(field)) {
        updated.delete(field);
      } else {
        updated.add(field);
      }
      return updated;
    });
  };

  if (!packet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[500px] sm:w-[600px]">
          <SheetHeader>
            <SheetTitle>Packet Details</SheetTitle>
            <SheetDescription>
              View detailed ILP packet information and routing path
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 text-gray-400">No packet selected</div>
        </SheetContent>
      </Sheet>
    );
  }

  // Format timestamp as relative time
  const formatRelativeTime = (timestamp: string): string => {
    const now = new Date().getTime();
    const packetTime = new Date(timestamp).getTime();
    const diffSeconds = Math.floor((now - packetTime) / 1000);

    if (diffSeconds < 60) return `${diffSeconds} seconds ago`;
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} minutes ago`;
    return `${Math.floor(diffSeconds / 3600)} hours ago`;
  };

  // Truncate packet ID for display
  const truncatedId =
    packet.packetId.length > 20 ? `${packet.packetId.substring(0, 20)}...` : packet.packetId;

  // Type badge color
  const typeBadgeColor =
    packet.type === 'PREPARE'
      ? 'bg-blue-600'
      : packet.type === 'FULFILL'
        ? 'bg-green-600'
        : 'bg-red-600';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] sm:w-[600px]">
        <SheetHeader>
          <SheetTitle>Packet Details</SheetTitle>
          <SheetDescription>View detailed ILP packet information and routing path</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="formatted" className="mt-6">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="formatted">Formatted View</TabsTrigger>
            <TabsTrigger value="json">JSON View</TabsTrigger>
          </TabsList>

          <TabsContent value="formatted" className="mt-4 space-y-4">
            {/* Recently Viewed Packets */}
            {recentPacketIds.length > 1 && (
              <>
                <div className="space-y-2">
                  <h3 className="font-semibold text-sm">Recently Viewed</h3>
                  <div className="flex flex-wrap gap-2">
                    {recentPacketIds.slice(1).map((packetId) => (
                      <button
                        key={packetId}
                        onClick={() => onSelectPacket?.(packetId)}
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-mono text-gray-300 transition-colors"
                        title={packetId}
                      >
                        {packetId.length > 12 ? `${packetId.substring(0, 12)}...` : packetId}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border-b border-gray-700" />
              </>
            )}

            {/* Packet Header */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-1 rounded text-xs font-semibold text-white ${typeBadgeColor}`}
                >
                  {packet.type}
                </span>
              </div>
              <div className="text-sm">
                <span className="font-semibold">ID:</span>{' '}
                <span className="font-mono text-gray-300" title={packet.packetId}>
                  {truncatedId}
                </span>
              </div>
              <div className="text-sm text-gray-400">{formatRelativeTime(packet.timestamp)}</div>
            </div>

            {/* Divider */}
            <div className="border-b border-gray-700" />

            {/* Packet Details Grid */}
            <div className="space-y-3">
              <div className="grid grid-cols-[120px_1fr] gap-2">
                <span className="font-semibold text-sm">Source:</span>
                <span className="font-mono text-sm text-gray-300">{packet.sourceNodeId}</span>
              </div>

              <div className="grid grid-cols-[120px_1fr] gap-2">
                <span className="font-semibold text-sm">Destination:</span>
                <span className="font-mono text-sm text-gray-300 break-all">
                  {packet.destinationAddress}
                </span>
              </div>

              <div className="grid grid-cols-[120px_1fr] gap-2">
                <span className="font-semibold text-sm">Type:</span>
                <span className="font-mono text-sm text-gray-300">{packet.type}</span>
              </div>
            </div>

            {/* ILP-Specific Fields based on packet type */}
            {packet.type === 'PREPARE' && (
              <>
                <div className="border-b border-gray-700" />
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Prepare Details</h3>

                  {packet.amount && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Amount:</span>
                      <span className="font-mono text-sm text-gray-300">{packet.amount} units</span>
                    </div>
                  )}

                  {packet.executionCondition && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Condition:</span>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-gray-300 break-all">
                          {expandedFields.has('executionCondition')
                            ? formatHex(packet.executionCondition)
                            : truncateHex(formatHex(packet.executionCondition), 32)}
                        </div>
                        <div className="flex gap-2">
                          {packet.executionCondition.length > 32 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleExpanded('executionCondition')}
                              className="h-6 text-xs"
                            >
                              {expandedFields.has('executionCondition') ? 'Show Less' : 'Show More'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              copyToClipboard(packet.executionCondition!, 'Execution Condition')
                            }
                            className="h-6 text-xs"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {packet.expiresAt && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Expires At:</span>
                      <div className="font-mono text-sm text-gray-300">
                        <div>{packet.expiresAt}</div>
                        <div className="text-xs text-gray-400">
                          {formatRelativeTime(packet.expiresAt)}
                        </div>
                      </div>
                    </div>
                  )}

                  {packet.dataPayload && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Data Payload:</span>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-gray-300 break-all">
                          {expandedFields.has('dataPayload')
                            ? formatHex(packet.dataPayload)
                            : truncateHex(formatHex(packet.dataPayload), 32)}
                        </div>
                        <div className="flex gap-2">
                          {packet.dataPayload.length > 32 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleExpanded('dataPayload')}
                              className="h-6 text-xs"
                            >
                              {expandedFields.has('dataPayload') ? 'Show Less' : 'Show More'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(packet.dataPayload!, 'Data Payload')}
                            className="h-6 text-xs"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {packet.type === 'FULFILL' && (
              <>
                <div className="border-b border-gray-700" />
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Fulfill Details</h3>

                  {packet.fulfillment && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Fulfillment:</span>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-gray-300 break-all">
                          {expandedFields.has('fulfillment')
                            ? formatHex(packet.fulfillment)
                            : truncateHex(formatHex(packet.fulfillment), 32)}
                        </div>
                        <div className="flex gap-2">
                          {packet.fulfillment.length > 32 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleExpanded('fulfillment')}
                              className="h-6 text-xs"
                            >
                              {expandedFields.has('fulfillment') ? 'Show Less' : 'Show More'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(packet.fulfillment!, 'Fulfillment')}
                            className="h-6 text-xs"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {packet.dataPayload && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Data Payload:</span>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-gray-300 break-all">
                          {expandedFields.has('dataPayload')
                            ? formatHex(packet.dataPayload)
                            : truncateHex(formatHex(packet.dataPayload), 32)}
                        </div>
                        <div className="flex gap-2">
                          {packet.dataPayload.length > 32 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleExpanded('dataPayload')}
                              className="h-6 text-xs"
                            >
                              {expandedFields.has('dataPayload') ? 'Show Less' : 'Show More'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(packet.dataPayload!, 'Data Payload')}
                            className="h-6 text-xs"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {packet.type === 'REJECT' && (
              <>
                <div className="border-b border-gray-700" />
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Reject Details</h3>

                  {packet.errorCode && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Error Code:</span>
                      <span className="font-mono text-sm text-red-400">{packet.errorCode}</span>
                    </div>
                  )}

                  {packet.errorMessage && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Error Message:</span>
                      <span className="font-mono text-sm text-gray-300">{packet.errorMessage}</span>
                    </div>
                  )}

                  {packet.triggeredBy && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Triggered By:</span>
                      <span className="font-mono text-sm text-gray-300">{packet.triggeredBy}</span>
                    </div>
                  )}

                  {packet.dataPayload && (
                    <div className="grid grid-cols-[120px_1fr] gap-2">
                      <span className="font-semibold text-sm">Data Payload:</span>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-gray-300 break-all">
                          {expandedFields.has('dataPayload')
                            ? formatHex(packet.dataPayload)
                            : truncateHex(formatHex(packet.dataPayload), 32)}
                        </div>
                        <div className="flex gap-2">
                          {packet.dataPayload.length > 32 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleExpanded('dataPayload')}
                              className="h-6 text-xs"
                            >
                              {expandedFields.has('dataPayload') ? 'Show Less' : 'Show More'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(packet.dataPayload!, 'Data Payload')}
                            className="h-6 text-xs"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Routing Path Visualization */}
            {packet.routingPath.length > 0 && (
              <>
                <div className="border-b border-gray-700" />
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Routing Path</h3>

                  <div className="space-y-2">
                    {packet.routingPath.map((nodeId, index) => {
                      const isSource = index === 0;
                      const isLast = index === packet.routingPath.length - 1;

                      return (
                        <div key={`${nodeId}-${index}`} className="flex items-start gap-3">
                          {/* Timeline indicator */}
                          <div className="flex flex-col items-center">
                            <div
                              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                                isSource
                                  ? 'bg-blue-600 text-white'
                                  : isLast
                                    ? 'bg-green-600 text-white'
                                    : 'bg-gray-600 text-gray-300'
                              }`}
                            >
                              {isSource ? 'S' : index}
                            </div>
                            {!isLast && <div className="w-0.5 h-6 bg-gray-600 mt-1"></div>}
                          </div>

                          {/* Node info */}
                          <div className="flex-1 pt-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-gray-300">{nodeId}</span>
                              {isSource && (
                                <span className="px-2 py-0.5 bg-blue-600/20 text-blue-400 text-xs rounded">
                                  Source
                                </span>
                              )}
                              {isLast && (
                                <span className="px-2 py-0.5 bg-green-600/20 text-green-400 text-xs rounded">
                                  Destination
                                </span>
                              )}
                              {!isSource && !isLast && (
                                <span className="px-2 py-0.5 bg-gray-600/20 text-gray-400 text-xs rounded">
                                  Hop {index}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* Empty routing path message */}
            {packet.routingPath.length === 0 && (
              <>
                <div className="border-b border-gray-700" />
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Routing Path</h3>
                  <div className="text-sm text-gray-400 italic">Path not yet determined</div>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="json" className="mt-4">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold text-sm">JSON Representation</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(JSON.stringify(packet, null, 2), 'JSON Data')}
                  className="h-8 text-xs"
                >
                  Copy JSON
                </Button>
              </div>
              <pre className="font-mono text-xs bg-gray-800 p-4 rounded overflow-auto max-h-[500px] text-gray-300">
                {JSON.stringify(packet, null, 2)}
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
