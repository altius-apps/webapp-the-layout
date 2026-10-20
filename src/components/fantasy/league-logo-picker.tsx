'use client';

// League logo picker modal — structural clone of
// src/components/settings/avatar-upload-modal.tsx retargeted at a league's
// logo instead of the signed-in user's profile icon.
//   - "Photo"  → upload an image → `league-logos` bucket, path
//     `${leagueId}/${uuid}${ext}`, persisted via setLeagueLogo({url, icon:null}).
//   - a LEAGUE tab → pick a stored team logo/flag → persisted via
//     setLeagueLogo({url:null, icon}).
// setLeagueLogo (fantasy_set_league_logo RPC) enforces the url XOR icon
// invariant and commissioner-only write; this component just calls it.
//
// Not wired into any page yet — the Settings page that uses it belongs to a
// different work track. Built to the prop contract so it's ready to import.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase/client';
import { setLeagueLogo } from '@/lib/fantasy/leagues';
import {
  ICON_LEAGUES,
  formatAvatarIcon,
  listIconTeams,
  listPulIconTeams,
  parseAvatarIcon,
  type IconLeague,
  type IconTeam,
} from '@/lib/profile/avatar-icon';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';

interface LeagueLogoPickerProps {
  open: boolean;
  onClose: () => void;
  leagueId: string;
  leagueName: string;
  currentLogoUrl: string | null;
  currentLogoIcon: string | null;
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

type Status = 'idle' | 'uploading' | 'error';
type Tab = 'photo' | IconLeague;

const LEAGUE_LABEL: Record<IconLeague, string> = {
  ufa: 'UFA',
  usau: 'USAU',
  pul: 'PUL',
  wul: 'WUL',
  wfdf: 'WFDF',
  euf: 'EUCS',
};

function guessExtension(file: File): string {
  const fromName = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0];
  if (fromName) return fromName.toLowerCase();
  switch (file.type) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '';
  }
}

function validateFile(f: File): string | null {
  if (!(ALLOWED_MIME as readonly string[]).includes(f.type)) {
    return "That file isn't a supported type. Use JPG, PNG, WEBP, or GIF.";
  }
  if (f.size > MAX_BYTES) {
    return `That file is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`;
  }
  return null;
}

/** Best-effort delete of the previous logo object, scoped to this league's
 *  own storage prefix — never touches another league's object even if the
 *  URL shape is unexpected. No-op (never throws) on any failure. */
async function deletePreviousLogo(leagueId: string, previousUrl: string | null) {
  if (!previousUrl) return;
  const marker = '/league-logos/';
  const idx = previousUrl.indexOf(marker);
  if (idx === -1) return;
  const objectPath = previousUrl.slice(idx + marker.length);
  if (!objectPath.startsWith(`${leagueId}/`)) return;
  try {
    const supabase = createClient();
    await supabase.storage.from('league-logos').remove([objectPath]);
  } catch {
    /* best-effort — an orphaned object costs nothing but storage */
  }
}

export function LeagueLogoPicker({
  open,
  onClose,
  leagueId,
  leagueName,
  currentLogoUrl,
  currentLogoIcon,
}: LeagueLogoPickerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const initialTab = (): Tab => {
    const ref = parseAvatarIcon(currentLogoIcon);
    return ref ? ref.league : 'photo';
  };
  const [tab, setTab] = useState<Tab>(initialTab);
  const [savingRef, setSavingRef] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreviewUrl(null);
    setStatus('idle');
    setError(null);
    setSavingRef(null);
    setTab(initialTab());
    if (fileInputRef.current) fileInputRef.current.value = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && status !== 'uploading') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, status, onClose]);

  if (!open || !mounted) return null;

  function pickFile(next: FileList | null) {
    setError(null);
    if (!next || next.length === 0) return;
    const picked = next[0];
    const err = validateFile(picked);
    if (err) {
      setError(err);
      setFile(null);
      setPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
    setStatus('idle');
  }

  async function handleSave() {
    if (!file || status === 'uploading') return;
    setStatus('uploading');
    setError(null);

    const supabase = createClient();
    const ext = guessExtension(file);
    const objectPath = `${leagueId}/${crypto.randomUUID()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('league-logos')
      .upload(objectPath, file, {
        cacheControl: '31536000',
        contentType: file.type,
        upsert: false,
      });
    if (uploadError) {
      setStatus('error');
      setError(uploadError.message || 'Upload failed. Please try again.');
      return;
    }

    const { data } = supabase.storage.from('league-logos').getPublicUrl(objectPath);

    try {
      await setLeagueLogo(leagueId, { url: data.publicUrl, icon: null });
    } catch (e) {
      await supabase.storage.from('league-logos').remove([objectPath]);
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not save your logo. Please try again.');
      return;
    }

    await deletePreviousLogo(leagueId, currentLogoUrl);
    onClose();
  }

  async function handlePickIcon(league: IconLeague, team: IconTeam) {
    if (status === 'uploading') return;
    const ref = formatAvatarIcon(league, team.id);
    setSavingRef(ref);
    setStatus('uploading');
    setError(null);
    try {
      await setLeagueLogo(leagueId, { url: null, icon: ref });
    } catch (e) {
      setStatus('error');
      setSavingRef(null);
      setError(e instanceof Error ? e.message : 'Could not set that logo. Please try again.');
      return;
    }
    await deletePreviousLogo(leagueId, currentLogoUrl);
    onClose();
  }

  async function handleRemove() {
    if (status === 'uploading') return;
    setStatus('uploading');
    setError(null);
    try {
      await setLeagueLogo(leagueId, { url: null, icon: null });
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not remove the logo. Please try again.');
      return;
    }
    await deletePreviousLogo(leagueId, currentLogoUrl);
    onClose();
  }

  const initials = initialsOf(leagueName);
  const hasLogo = !!currentLogoUrl || !!currentLogoIcon;
  const busy = status === 'uploading';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="league-logo-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-[460px] max-h-full overflow-hidden bg-surface rounded-card-lg shadow-hero flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex flex-col gap-2 shrink-0">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
            League
          </span>
          <h2
            id="league-logo-modal-title"
            className="m-0 font-display italic font-bold text-[26px] leading-[0.95] tracking-[-0.03em] text-ink"
          >
            League logo.
          </h2>
          <p className="text-[13px] text-muted font-tight leading-snug">
            Pick a team logo or upload a photo. Shown for {leagueName} everywhere in the app.
          </p>
        </div>

        {/* Tabs */}
        <div className="px-6 shrink-0">
          <div
            role="tablist"
            aria-label="League logo source"
            className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-0.5 no-scrollbar"
          >
            <TabButton label="Photo" active={tab === 'photo'} onClick={() => setTab('photo')} disabled={busy} />
            {ICON_LEAGUES.map((lg) => (
              <TabButton
                key={lg}
                label={LEAGUE_LABEL[lg]}
                active={tab === lg}
                onClick={() => setTab(lg)}
                disabled={busy}
              />
            ))}
          </div>
        </div>

        {/* Body — scrolls */}
        <div className="px-6 pt-4 pb-4 flex-1 min-h-0 overflow-y-auto">
          {tab === 'photo' ? (
            <PhotoPanel
              previewUrl={previewUrl}
              currentLogoUrl={currentLogoUrl}
              currentLogoIcon={currentLogoIcon}
              leagueName={leagueName}
              initials={initials}
              fileInputRef={fileInputRef}
              onPick={pickFile}
              busy={busy}
            />
          ) : (
            <LeagueGrid
              league={tab}
              currentLogoIcon={currentLogoIcon}
              savingRef={savingRef}
              onPick={handlePickIcon}
              busy={busy}
            />
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 w-full text-[12px] font-medium font-tight text-live bg-live/[0.08] rounded-card-sm px-3.5 py-2"
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer / actions */}
        <div className="px-6 pb-6 pt-3 flex flex-col gap-2.5 border-t border-hairline shrink-0">
          {tab === 'photo' && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!file || busy}
              className={[
                'inline-flex items-center justify-center gap-2 w-full py-3 rounded-full cursor-pointer',
                'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.16em] uppercase',
                'hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              {busy ? (
                <>
                  <span
                    className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin"
                    aria-hidden="true"
                  />
                  Saving…
                </>
              ) : (
                'Save logo'
              )}
            </button>
          )}

          {hasLogo && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy}
              className={[
                'w-full py-2.5 rounded-full cursor-pointer text-center',
                'text-[11px] font-bold tracking-[0.14em] uppercase font-tight text-live',
                'hover:bg-live/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              Remove logo
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={[
              'text-[10px] font-bold tracking-[0.16em] uppercase text-faint hover:text-ink font-tight transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm mx-auto',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {tab === 'photo' ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={[
        'shrink-0 px-3.5 py-2 min-h-[40px] rounded-full text-[11px] font-bold tracking-[0.1em] uppercase font-tight',
        'transition-colors cursor-pointer whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'bg-ink text-bg' : 'text-muted hover:text-ink hover:bg-ink/[0.05]',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// ─── Photo (upload) panel ─────────────────────────────────────────────────────

function PhotoPanel({
  previewUrl,
  currentLogoUrl,
  currentLogoIcon,
  leagueName,
  initials,
  fileInputRef,
  onPick,
  busy,
}: {
  previewUrl: string | null;
  currentLogoUrl: string | null;
  currentLogoIcon: string | null;
  leagueName: string;
  initials: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (files: FileList | null) => void;
  busy: boolean;
}) {
  const currentIconResolved = currentLogoIcon ? parseAvatarIcon(currentLogoIcon) : null;
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-28 h-28 rounded-full overflow-hidden bg-ink/5 flex items-center justify-center shrink-0">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Selected logo preview" className="w-full h-full object-cover" />
        ) : currentLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentLogoUrl} alt={`${leagueName} current logo`} className="w-full h-full object-cover" />
        ) : currentIconResolved ? (
          <span className="font-display italic font-bold text-[14px] text-muted" aria-hidden="true">
            {LEAGUE_LABEL[currentIconResolved.league]}
          </span>
        ) : (
          <span className="font-display italic font-bold text-[36px] text-muted" aria-hidden="true">
            {initials}
          </span>
        )}
      </div>

      <label className="w-full flex flex-col gap-1.5">
        <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
          Choose a photo
        </span>
        <input
          ref={fileInputRef as React.RefObject<HTMLInputElement>}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={(e) => onPick(e.target.files)}
          disabled={busy}
          className={[
            'w-full text-[12.5px] font-tight text-muted rounded-card-sm bg-ink/5 px-3 py-2.5',
            'file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0',
            'file:text-[10px] file:font-bold file:tracking-[0.12em] file:uppercase file:font-tight',
            'file:bg-ink file:text-bg file:cursor-pointer hover:file:opacity-90 file:transition-opacity',
            'cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed',
          ].join(' ')}
        />
        <span className="text-[10.5px] text-faint font-tight">
          JPG, PNG, WEBP, or GIF · up to 5 MB
        </span>
      </label>
    </div>
  );
}

// ─── League logo grid ─────────────────────────────────────────────────────────

function LeagueGrid({
  league,
  currentLogoIcon,
  savingRef,
  onPick,
  busy,
}: {
  league: IconLeague;
  currentLogoIcon: string | null;
  savingRef: string | null;
  onPick: (league: IconLeague, team: IconTeam) => void;
  busy: boolean;
}) {
  const staticTeams = useMemo(() => (league === 'pul' ? [] : listIconTeams(league)), [league]);
  const [pulTeams, setPulTeams] = useState<IconTeam[] | null>(null);
  const [pulLoading, setPulLoading] = useState(false);

  useEffect(() => {
    if (league !== 'pul') return;
    let cancelled = false;
    setPulLoading(true);
    listPulIconTeams()
      .then((t) => {
        if (!cancelled) setPulTeams(t);
      })
      .finally(() => {
        if (!cancelled) setPulLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [league]);

  const teams = league === 'pul' ? pulTeams ?? [] : staticTeams;
  const loading = league === 'pul' && pulLoading && pulTeams === null;

  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [league]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => t.name.toLowerCase().includes(q));
  }, [teams, query]);

  const currentRef = currentLogoIcon;

  return (
    <div className="flex flex-col gap-3">
      {teams.length > 12 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${LEAGUE_LABEL[league]} teams…`}
          aria-label={`Filter ${LEAGUE_LABEL[league]} teams`}
          spellCheck={false}
          className={[
            'w-full bg-surface-hi px-3.5 py-2.5 text-[13px] font-semibold text-ink font-tight rounded-full min-h-[40px]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors',
          ].join(' ')}
        />
      )}

      {loading ? (
        <div className="py-10 flex items-center justify-center">
          <span
            className="w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin"
            aria-hidden="true"
          />
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-faint font-tight">
          {query ? `No ${LEAGUE_LABEL[league]} teams match "${query}".` : `No ${LEAGUE_LABEL[league]} teams available.`}
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={`${LEAGUE_LABEL[league]} teams`}
          className="grid grid-cols-4 sm:grid-cols-5 gap-2.5 max-h-[280px] overflow-y-auto pr-0.5"
        >
          {filtered.map((team) => {
            const ref = formatAvatarIcon(league, team.id);
            const selected = ref === currentRef;
            const saving = ref === savingRef;
            return (
              <button
                key={team.id}
                type="button"
                role="option"
                aria-selected={selected}
                title={team.name}
                onClick={() => onPick(league, team)}
                disabled={busy}
                className={[
                  'group relative aspect-square rounded-card-sm overflow-hidden flex items-center justify-center',
                  'cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  selected ? 'ring-2 ring-accent' : 'ring-1 ring-hairline hover:ring-ink/25',
                  busy ? 'opacity-60 cursor-not-allowed' : '',
                ].join(' ')}
              >
                {league === 'wfdf' ? (
                  <span className="w-full h-full flex items-center justify-center bg-ink/[0.04]">
                    <WfdfFlag countryCode={team.countryCode ?? null} size={30} />
                  </span>
                ) : team.logoUrl ? (
                  <span className="w-full h-full flex items-center justify-center bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={team.logoUrl} alt={team.name} className="w-full h-full object-contain p-1.5" loading="lazy" />
                  </span>
                ) : (
                  <span className="w-full h-full flex items-center justify-center bg-ink text-bg text-[11px] font-bold">
                    {monogram(team.name)}
                  </span>
                )}

                {saving && (
                  <span className="absolute inset-0 flex items-center justify-center bg-surface/70">
                    <span
                      className="w-4 h-4 rounded-full border-2 border-ink/20 border-t-accent animate-spin"
                      aria-hidden="true"
                    />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function monogram(name: string): string {
  const words = name.replace(/\(.*\)/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0][0]?.toUpperCase() ?? '';
  const first = words[0][0] ?? '';
  const last = words[words.length - 1][0] ?? '';
  return (first + last).toUpperCase();
}
