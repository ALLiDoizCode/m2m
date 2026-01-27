import { Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface JumpToLiveProps {
  /** Whether the button should be visible */
  visible: boolean;
  /** Connection status */
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  /** Callback when button is clicked */
  onClick: () => void;
}

/**
 * Floating "Jump to live" button
 * Appears when in History mode, allows switching back to live stream
 */
export function JumpToLive({ visible, connectionStatus, onClick }: JumpToLiveProps) {
  if (!visible) {
    return null;
  }

  // Show reconnecting state if not connected
  if (connectionStatus === 'connecting') {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <Button variant="secondary" size="lg" disabled className="shadow-lg animate-pulse">
          <Radio className="h-4 w-4 mr-2" />
          Reconnecting...
        </Button>
      </div>
    );
  }

  if (connectionStatus === 'error' || connectionStatus === 'disconnected') {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <Button variant="destructive" size="lg" onClick={onClick} className="shadow-lg">
          <Radio className="h-4 w-4 mr-2" />
          Reconnect to Live
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <Button
        variant="default"
        size="lg"
        onClick={onClick}
        className="shadow-lg bg-green-600 hover:bg-green-700"
      >
        <Radio className="h-4 w-4 mr-2 animate-pulse" />
        Jump to Live
      </Button>
    </div>
  );
}
