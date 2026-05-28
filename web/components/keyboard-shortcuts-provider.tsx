'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useRouter } from 'next/navigation';
import { KeyboardShortcutsHelp } from './keyboard-shortcuts-help';
import { QuickSwitcher } from './quick-switcher';
import { CommandPalette } from './command-palette';
import { useCognitiveMode } from '@/contexts/cognitive-mode-context';

interface KeyboardShortcutsContextValue {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  quickSwitcherOpen: boolean;
  setQuickSwitcherOpen: (open: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextValue>({
  helpOpen: false,
  setHelpOpen: () => {},
  quickSwitcherOpen: false,
  setQuickSwitcherOpen: () => {},
  commandPaletteOpen: false,
  setCommandPaletteOpen: () => {},
});

export function useKeyboardShortcuts() {
  return useContext(KeyboardShortcutsContext);
}

/** Returns true when the active element is an editable field. */
function isEditableTarget(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const { setMode } = useCognitiveMode();

  // --- "G then X" sequence state ---
  const gPending = useRef(false);
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGPending = useCallback(() => {
    gPending.current = false;
    if (gTimer.current) {
      clearTimeout(gTimer.current);
      gTimer.current = null;
    }
  }, []);

  // Listen for the "g" prefix key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditableTarget()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (gPending.current) {
        // Second key of the sequence
        const key = e.key.toLowerCase();
        const routes: Record<string, string> = {
          d: '/dashboard',
          k: '/knowledge',
          g: '/graph',
          s: '/search',
        };
        if (routes[key]) {
          e.preventDefault();
          router.push(routes[key]);
        }
        clearGPending();
        return;
      }

      if (e.key.toLowerCase() === 'g') {
        gPending.current = true;
        gTimer.current = setTimeout(clearGPending, 800);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearGPending();
    };
  }, [router, clearGPending]);

  // Cmd/Ctrl + K → Command Palette
  useHotkeys(
    'mod+k',
    (e) => {
      e.preventDefault();
      setCommandPaletteOpen((prev) => !prev);
    },
    { enableOnFormTags: false },
  );

  // Cmd/Ctrl + O → Quick Switcher
  useHotkeys(
    'mod+o',
    (e) => {
      e.preventDefault();
      setQuickSwitcherOpen((prev) => !prev);
    },
    { enableOnFormTags: false },
  );

  // Cmd/Ctrl + N → New knowledge entry
  useHotkeys(
    'mod+n',
    (e) => {
      e.preventDefault();
      router.push('/knowledge/new');
    },
    { enableOnFormTags: false },
  );

  // Cmd/Ctrl + / → Toggle help panel
  useHotkeys(
    'mod+/',
    (e) => {
      e.preventDefault();
      setHelpOpen((prev) => !prev);
    },
    { enableOnFormTags: true },
  );

  // Ctrl+1 → Focus mode
  useHotkeys(
    'ctrl+1',
    (e) => {
      e.preventDefault();
      setMode('focus');
    },
    { enableOnFormTags: false },
  );

  // Ctrl+2 → Explore mode
  useHotkeys(
    'ctrl+2',
    (e) => {
      e.preventDefault();
      setMode('explore');
    },
    { enableOnFormTags: false },
  );

  // Ctrl+3 → Overview mode
  useHotkeys(
    'ctrl+3',
    (e) => {
      e.preventDefault();
      setMode('overview');
    },
    { enableOnFormTags: false },
  );

  // Escape → Close topmost overlay
  useHotkeys(
    'escape',
    () => {
      if (commandPaletteOpen) setCommandPaletteOpen(false);
      else if (quickSwitcherOpen) setQuickSwitcherOpen(false);
      else if (helpOpen) setHelpOpen(false);
    },
    { enableOnFormTags: true },
    [helpOpen, quickSwitcherOpen, commandPaletteOpen],
  );

  return (
    <KeyboardShortcutsContext.Provider
      value={{
        helpOpen,
        setHelpOpen,
        quickSwitcherOpen,
        setQuickSwitcherOpen,
        commandPaletteOpen,
        setCommandPaletteOpen,
      }}
    >
      {children}
      <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <QuickSwitcher open={quickSwitcherOpen} onOpenChange={setQuickSwitcherOpen} />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </KeyboardShortcutsContext.Provider>
  );
}
