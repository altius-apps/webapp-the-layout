'use client';

// Signed-out view of every league screen (Hunter, 2026-10-14: fantasy leagues
// are signed-in only, on web and mobile). Signing in from here re-renders the
// league server-side with the new session.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '@/components/auth/auth-gate';

function RefreshOnSignIn() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-faint">
      <span className="text-[10px] font-bold tracking-[0.18em] uppercase font-tight">Opening your league…</span>
    </div>
  );
}

export function FantasySignInGate({ headline = 'Sign in to see this league.' }: { headline?: string }) {
  return (
    <AuthGate
      eyebrow="Fantasy"
      headline={headline}
      subhead="Standings, teams and chat are for signed-in players. Sign in or create a free account to join in."
    >
      <RefreshOnSignIn />
    </AuthGate>
  );
}
