'use client';

import dynamic from 'next/dynamic';
import { useAuth } from '@/lib/auth/auth-provider';

// Signed-in users only, so anonymous visitors never download the moderation
// word lists the prompt needs.
const DisplayNamePrompt = dynamic(() => import('./display-name-prompt'), { ssr: false });

export function DisplayNameGate() {
  const { user } = useAuth();
  return user ? <DisplayNamePrompt /> : null;
}
