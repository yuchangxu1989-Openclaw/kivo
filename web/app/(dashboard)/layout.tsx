import { AppShell } from '@/components/app-shell';
import { KeyboardShortcutsProvider } from '@/components/keyboard-shortcuts-provider';
import { CognitiveModeProvider } from '@/contexts/cognitive-mode-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <CognitiveModeProvider>
      <KeyboardShortcutsProvider>
        <AppShell>{children}</AppShell>
      </KeyboardShortcutsProvider>
    </CognitiveModeProvider>
  );
}
