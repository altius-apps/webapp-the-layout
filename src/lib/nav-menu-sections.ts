// The mega-menu sections served by /api/nav-menu/[section]. Shared with the
// middleware, which 404s anything else before Next can cache it (each unknown
// path would otherwise become its own hour-long ISR entry).
export const NAV_MENU_SECTIONS = ['usau', 'usau-college', 'pul', 'wfdf', 'euf'] as const;
export type NavMenuSection = (typeof NAV_MENU_SECTIONS)[number];
