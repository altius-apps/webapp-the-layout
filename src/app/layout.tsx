import { Suspense } from 'react';
import type { Metadata, Viewport } from 'next';
import { Antonio, Inter, Inter_Tight } from 'next/font/google';
import './globals.css';
import { ThemeBootstrap } from '@/components/theme-bootstrap';
import { AuthProvider } from '@/lib/auth/auth-provider';
import { DisplayNameGate } from '@/components/auth/display-name-gate';
import { FavoritesOnboardingModal } from '@/components/favorites/favorites-onboarding-modal';
import { MobileBottomNav } from '@/components/mobile-bottom-nav';
import { NavHistoryTracker } from '@/lib/nav-history';

const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-tight',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const antonio = Antonio({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  // Base for relative alternates/canonical URLs (e.g. the player-profile
  // canonical that collapses ?from= crawl duplicates).
  metadataBase: new URL('https://thelayout.app'),
  title: 'The Layout · Ultimate Frisbee',
  description: 'Live Ultimate Frisbee scores from the UFA, USAU Club, and International ultimate.',
};

// Without an explicit viewport, mobile browsers assume a ~980px layout width
// and scale the page down (or let it overflow) — which broke scaling across
// phone models and clipped the right-edge controls. width=device-width +
// initial-scale=1 makes the layout viewport match the device. viewport-fit
// cover lets us use env(safe-area-inset-*) on notched phones.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Single stable default = the field (tan) theme's --bg. We DON'T key this on
  // prefers-color-scheme because our theme is app-controlled (data-theme), not
  // OS-controlled — an OS-dark phone would otherwise get a dark bar behind the
  // tan page. ThemeBootstrap + use-theme overwrite this meta at runtime to match
  // the active theme (see THEME_BAR_COLOR); this value is just the pre-JS paint.
  themeColor: '#F4F2EC',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="field" className={`${interTight.variable} ${inter.variable} ${antonio.variable}`}>
      <head>
        <ThemeBootstrap />
      </head>
      <body className="font-sans bg-bg text-ink min-h-screen">
        <AuthProvider>
          {children}
          <FavoritesOnboardingModal />
          <DisplayNameGate />
          {/* Global static bottom bar (mobile only — self-gated lg:hidden).
              Mounted ONCE at the root so it's truly app-wide regardless of which
              shell a page uses (AppShell, PlaybookShell, bespoke home, etc.) and
              so its `position: fixed` resolves against the viewport, not a
              transformed shell ancestor. Suspense: it reads usePathname. */}
          <Suspense fallback={null}>
            <MobileBottomNav />
          </Suspense>
          {/* Records the previous in-app route for the breadcrumbs' smart
              back (see lib/nav-history). Suspense: reads useSearchParams. */}
          <Suspense fallback={null}>
            <NavHistoryTracker />
          </Suspense>
        </AuthProvider>
      </body>
    </html>
  );
}
