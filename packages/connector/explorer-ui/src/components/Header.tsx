import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { HealthResponse } from '../lib/event-types';

interface HeaderProps {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  eventCount: number;
}

export function Header({ status, eventCount }: HeaderProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/api/health');
        if (response.ok) {
          const data = await response.json();
          setHealth(data);
        }
      } catch (err) {
        console.error('Failed to fetch health:', err);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 30000); // Refresh every 30s

    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'bg-green-500';
      case 'connecting':
        return 'bg-yellow-500';
      case 'disconnected':
        return 'bg-gray-500';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  return (
    <header className="border-b border-border px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">M2M Explorer</h1>
          {health && (
            <span className="text-sm text-muted-foreground">
              Node: <span className="font-mono">{health.nodeId}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className="font-mono">
            {eventCount} events
          </Badge>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
            <span className="text-sm text-muted-foreground capitalize">{status}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
