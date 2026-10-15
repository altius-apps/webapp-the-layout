'use client';

// True while a text field has focus, i.e. the phone keyboard is up. Fixed
// bottom chrome (the app's bottom nav) steps aside then, or it rides up on top
// of the keyboard (Hunter, 2026-10-14).

import { useEffect, useState } from 'react';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image', 'hidden']);

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

export function useTextEntryFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onIn = (e: FocusEvent) => {
      if (!isTextEntry(e.target)) return;
      clearTimeout(timer);
      setFocused(true);
    };
    // Deferred, so moving from one field to the next doesn't flash the bar.
    const onOut = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setFocused(isTextEntry(document.activeElement)), 100);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return focused;
}
