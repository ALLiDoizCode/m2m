import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface KeyboardHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SHORTCUTS = [
  { key: 'j / ↓', action: 'Move selection down', context: 'Events tab' },
  { key: 'k / ↑', action: 'Move selection up', context: 'Events tab' },
  { key: 'Enter', action: 'Open event detail panel', context: 'Events tab' },
  { key: 'Escape', action: 'Close detail panel', context: 'Detail panel open' },
  { key: '1', action: 'Switch to Events tab', context: 'Global' },
  { key: '2', action: 'Switch to Accounts tab', context: 'Global' },
  { key: '3', action: 'Switch to Peers tab', context: 'Global' },
  { key: '/', action: 'Focus search input', context: 'Global' },
  { key: '?', action: 'Show this help', context: 'Global' },
];

export function KeyboardHelpDialog({ open, onOpenChange }: KeyboardHelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Navigate the Agent Explorer using keyboard shortcuts.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Key</th>
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Action</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Context</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.key} className="border-b border-border/50">
                  <td className="py-2 pr-4">
                    <kbd className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-xs font-mono font-medium">
                      {shortcut.key}
                    </kbd>
                  </td>
                  <td className="py-2 pr-4">{shortcut.action}</td>
                  <td className="py-2 text-muted-foreground text-xs">{shortcut.context}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
