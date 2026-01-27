import { useEffect, useState, memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Keyboard } from 'lucide-react';
import { HealthResponse } from '../lib/event-types';

interface HeaderProps {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  eventCount: number;
  onHelpOpen?: () => void;
}

export const Header = memo(function Header({ status, eventCount, onHelpOpen }: HeaderProps) {
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
    <header className="border-b border-border px-4 md:px-6 py-3 md:py-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <h1 className="text-lg md:text-xl font-bold whitespace-nowrap">Agent Explorer</h1>
          {health && (
            <span className="text-xs md:text-sm text-muted-foreground truncate hidden sm:inline">
              Node: <span className="font-mono">{health.nodeId}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className="font-mono">
            {eventCount} events
          </Badge>
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full transition-colors duration-300 ${getStatusColor()}`}
            />
            <span className="text-sm text-muted-foreground capitalize">{status}</span>
          </div>
          {onHelpOpen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onHelpOpen}
              title="Keyboard shortcuts (?)"
              className="h-8 w-8"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
});
