// Per-request dedupe of getLeague: the league layout and the page under it
// both need the league flags (isOfficial, isPublic) within one render.

import 'server-only';
import { cache } from 'react';
import { getLeague } from './leagues';

export const getLeagueCached = cache(getLeague);
