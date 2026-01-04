/**
 * PacketAnimation component - Renders animated packets moving between nodes
 * Uses Cytoscape.js temporary nodes with requestAnimationFrame for smooth 60fps updates
 */

import React, { useEffect, useRef, useMemo } from 'react';
import { AnimatedPacket } from '../types/animation';
import Cytoscape from 'cytoscape';
import { createLogger } from '../utils/logger';

export interface PacketAnimationProps {
  /** Currently active packets to animate */
  activePackets: AnimatedPacket[];

  /** Cytoscape instance for rendering packet nodes */
  cyInstance: Cytoscape.Core | null;

  /** Callback when packet is clicked */
  onPacketClick?: (packetId: string) => void;
}

// Create logger instance for this component
const logger = createLogger('PacketAnimation');

/**
 * PacketAnimation component manages real-time packet flow visualization
 * Packets rendered as small colored circles moving along edges between nodes
 */
export const PacketAnimation = React.memo(
  ({ activePackets, cyInstance, onPacketClick }: PacketAnimationProps): null => {
    const animationFrameRef = useRef<number | null>(null);
    const renderedPacketsRef = useRef<Set<string>>(new Set());
    const lastInteractionTimeRef = useRef<Map<string, number>>(new Map());

    // Check for prefers-reduced-motion accessibility setting
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Group packets by edge for staggered positioning
    // Use useMemo to cache calculations and prevent unnecessary recomputation
    const packetsByEdge = useMemo(() => {
      const grouping = new Map<string, AnimatedPacket[]>();
      activePackets.forEach((packet) => {
        const edgeKey = `${packet.sourceNodeId}-${packet.targetNodeId}`;
        const group = grouping.get(edgeKey) || [];
        group.push(packet);
        grouping.set(edgeKey, group);
      });
      return grouping;
    }, [activePackets]);

    useEffect(() => {
      if (!cyInstance) {
        return;
      }

      // If user prefers reduced motion, skip animations
      if (prefersReducedMotion) {
        logger.debug('Reduced motion preference detected, skipping animations');
        return;
      }

      // Track which packets are currently rendered
      const currentPacketIds = new Set(activePackets.map((p) => p.id));

      // Remove packets that are no longer active
      renderedPacketsRef.current.forEach((packetId) => {
        if (!currentPacketIds.has(packetId)) {
          const packetNodeId = `packet-${packetId}`;
          const packetNode = cyInstance.getElementById(packetNodeId);
          if (packetNode.length > 0) {
            cyInstance.remove(packetNode);
          }
          renderedPacketsRef.current.delete(packetId);
        }
      });

      // Animation loop function
      const animate = (): void => {
        if (!cyInstance) {
          return;
        }

        const now = Date.now();

        activePackets.forEach((packet) => {
          // Calculate elapsed time and animation progress
          const elapsed = now - packet.startTime;
          let progress = Math.min(elapsed / packet.duration, 1.0);

          // Apply ease-out cubic easing for smooth deceleration
          progress = 1 - Math.pow(1 - progress, 3);

          // Cleanup if animation complete or stale (timeout)
          const isComplete = progress >= 1.0;
          const isStale = elapsed > packet.duration * 2; // 2x duration timeout

          if (isComplete || isStale) {
            if (isStale) {
              logger.warn(
                { packetId: packet.id, elapsed },
                'Packet animation timeout, forcing cleanup'
              );
            }

            // Remove packet node from Cytoscape graph
            const packetNodeId = `packet-${packet.id}`;
            const packetNode = cyInstance.getElementById(packetNodeId);
            if (packetNode.length > 0) {
              cyInstance.remove(packetNode);
            }
            renderedPacketsRef.current.delete(packet.id);
            return;
          }

          // Get source and target node positions
          const sourceNode = cyInstance.getElementById(packet.sourceNodeId);
          const targetNode = cyInstance.getElementById(packet.targetNodeId);

          if (sourceNode.length === 0 || targetNode.length === 0) {
            logger.warn(
              {
                packetId: packet.id,
                sourceNodeId: packet.sourceNodeId,
                targetNodeId: packet.targetNodeId,
              },
              'Missing nodes for packet'
            );
            return;
          }

          const sourcePos = sourceNode.position();
          const targetPos = targetNode.position();

          // Calculate edge vector and perpendicular offset for staggering
          const edgeKey = `${packet.sourceNodeId}-${packet.targetNodeId}`;
          const packetsOnEdge = packetsByEdge.get(edgeKey) || [];
          const packetIndex = packetsOnEdge.findIndex((p) => p.id === packet.id);

          // Calculate base interpolated position
          let interpolatedX = sourcePos.x + (targetPos.x - sourcePos.x) * progress;
          let interpolatedY = sourcePos.y + (targetPos.y - sourcePos.y) * progress;

          // Apply perpendicular offset if multiple packets on same edge
          if (packetsOnEdge.length > 1) {
            // Calculate perpendicular vector to edge
            const edgeVectorX = targetPos.x - sourcePos.x;
            const edgeVectorY = targetPos.y - sourcePos.y;
            const edgeLength = Math.sqrt(edgeVectorX * edgeVectorX + edgeVectorY * edgeVectorY);

            if (edgeLength > 0) {
              // Perpendicular vector (rotate 90 degrees)
              const perpX = -edgeVectorY / edgeLength;
              const perpY = edgeVectorX / edgeLength;

              // Offset distance (8px per packet, centered around edge)
              const offsetDistance = (packetIndex - (packetsOnEdge.length - 1) / 2) * 8;

              interpolatedX += perpX * offsetDistance;
              interpolatedY += perpY * offsetDistance;
            }
          }

          const packetNodeId = `packet-${packet.id}`;
          let packetNode = cyInstance.getElementById(packetNodeId);

          if (packetNode.length === 0) {
            // Create temporary packet node
            packetNode = cyInstance.add({
              group: 'nodes',
              data: {
                id: packetNodeId,
                isPacket: true,
              },
              position: {
                x: interpolatedX,
                y: interpolatedY,
              },
            });

            // Apply packet-specific styles with glow effect
            packetNode.style({
              'background-color': packet.color,
              width: 18,
              height: 18,
              shape: 'ellipse',
              'border-width': 0,
              label: '',
              'z-index': 1, // Lower z-index than connector nodes to avoid blocking clicks
              // Subtle glow effect for better visibility
              'box-shadow': `0 0 8px ${packet.color}`,
              cursor: 'pointer',
            });

            // Add click event listener with 100ms debounce to prevent accidental clicks
            packetNode.on('tap', () => {
              const now = Date.now();
              const lastInteraction = lastInteractionTimeRef.current.get(packet.id) || 0;

              // Only trigger click if packet visible for > 100ms
              if (now - lastInteraction > 100 && onPacketClick) {
                onPacketClick(packet.id);
              }
            });

            // Add hover effect
            packetNode.on('mouseover', () => {
              packetNode.style({
                width: 22,
                height: 22,
                'box-shadow': `0 0 12px ${packet.color}`,
              });
            });

            packetNode.on('mouseout', () => {
              packetNode.style({
                width: 18,
                height: 18,
                'box-shadow': `0 0 8px ${packet.color}`,
              });
            });

            // Record interaction time
            lastInteractionTimeRef.current.set(packet.id, now);
            renderedPacketsRef.current.add(packet.id);
          } else {
            // Update existing packet position
            packetNode.position({
              x: interpolatedX,
              y: interpolatedY,
            });
          }
        });

        // Continue animation loop if packets are active
        if (activePackets.length > 0) {
          animationFrameRef.current = requestAnimationFrame(animate);
        }
      };

      // Start animation loop if we have active packets
      if (activePackets.length > 0) {
        if (animationFrameRef.current === null) {
          animationFrameRef.current = requestAnimationFrame(animate);
        }
      } else {
        // No active packets, cancel animation loop
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      }

      // Cleanup function
      return () => {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      };
    }, [activePackets, cyInstance, packetsByEdge, prefersReducedMotion, onPacketClick]);

    // Cleanup all packet nodes on unmount
    useEffect(() => {
      return () => {
        if (cyInstance) {
          // Remove all packet nodes on unmount
          const packetNodes = cyInstance.nodes('[isPacket = true]');
          if (packetNodes.length > 0) {
            cyInstance.remove(packetNodes);
          }
        }
      };
    }, [cyInstance]);

    // This component doesn't render anything directly
    // All rendering is done via Cytoscape API
    return null;
  }
);

PacketAnimation.displayName = 'PacketAnimation';
