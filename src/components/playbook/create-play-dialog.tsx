'use client';

// Modal that walks the user through "new play" — name, field type, preset.
// Lives outside the editor so the editor stays focused on diagramming and
// doesn't have to expose a preset switcher mid-development.
//
// Renders nothing when `open` is false; on submit it fires `onCreate` with
// the validated payload and the parent closes the modal.

import { useEffect, useRef, useState } from 'react';
import { FormationPreview } from './formation-preview';
import { PRESET_LABELS, PRESET_ORDER } from '@/lib/playbook/presets';
import type { FieldType, FormationID } from '@/lib/playbook/types';

interface CreatePlayDialogProps {
  open: boolean;
  defaultName?: string;
  onCancel: () => void;
  onCreate: (payload: {
    name: string;
    fieldType: FieldType;
    formation: Exclude<FormationID, 'custom'>;
    withDefense: boolean;
  }) => void;
}

const FIELD_TYPES: Array<{ id: FieldType; label: string; sub: string }> = [
  { id: 'full',       label: 'Full field',  sub: '70 × 120 yd · standard' },
  { id: 'half',       label: 'Half field',  sub: 'Attacking half only' },
  { id: 'horizontal', label: 'Horizontal',  sub: 'Landscape — goal on the right' },
];

export function CreatePlayDialog({
  open,
  defaultName = 'Untitled play',
  onCancel,
  onCreate,
}: CreatePlayDialogProps) {
  const [name, setName] = useState(defaultName);
  const [fieldType, setFieldType] = useState<FieldType>('full');
  const [formation, setFormation] = useState<Exclude<FormationID, 'custom'>>('vert');
  const [withDefense, setWithDefense] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset when reopened.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setFieldType('full');
      setFormation('vert');
      setWithDefense(false);
      // Focus the name field on next paint.
      const t = setTimeout(() => nameRef.current?.select(), 30);
      return () => clearTimeout(t);
    }
  }, [open, defaultName]);

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-play-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({
            name: name.trim() || defaultName,
            fieldType,
            formation,
            withDefense,
          });
        }}
        className="w-full max-w-[640px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col"
      >
        <div className="px-5 py-4 border-b border-hairline flex items-baseline justify-between gap-3">
          <h2 id="new-play-title" className="font-display italic text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-ink m-0">
            New play
          </h2>
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
            Pick the canvas
          </span>
        </div>

        <div className="px-5 py-4 flex flex-col gap-5">
          {/* Play name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
              Play name
            </span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              spellCheck={false}
              className="bg-bg border border-hairline px-3 py-2 text-[14px] font-semibold text-ink font-tight focus-visible:outline-none focus-visible:border-ink rounded-card-sm"
            />
          </label>

          {/* Field type */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
              Field type
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {FIELD_TYPES.map((ft) => {
                const active = fieldType === ft.id;
                return (
                  <button
                    key={ft.id}
                    type="button"
                    onClick={() => setFieldType(ft.id)}
                    aria-pressed={active}
                    className={[
                      'flex flex-col gap-2 p-3 rounded-card-sm cursor-pointer transition-shadow text-left bg-bg',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active ? 'shadow-lift ring-1 ring-accent' : 'shadow-soft hover:shadow-lift',
                    ].join(' ')}
                  >
                    <FieldTypeIcon type={ft.id} active={active} />
                    <div>
                      <div className="text-[12px] font-bold text-ink font-tight leading-tight">
                        {ft.label}
                      </div>
                      <div className="text-[10px] text-faint font-tight mt-0.5">
                        {ft.sub}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Preset */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
              Starting preset
            </legend>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {PRESET_ORDER.map((id) => {
                const active = formation === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFormation(id)}
                    aria-pressed={active}
                    className={[
                      'flex flex-col gap-1.5 p-2 rounded-card-sm cursor-pointer transition-shadow',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active
                        ? 'bg-accent text-accent-ink shadow-lift'
                        : 'bg-bg shadow-soft text-muted hover:text-ink hover:shadow-lift',
                    ].join(' ')}
                  >
                    <div className="w-full aspect-[70/120] rounded-sm overflow-hidden">
                      {id === 'empty' ? (
                        <EmptyPreviewSvg active={active} />
                      ) : (
                        <FormationPreview formation={id} active={active} className="w-full h-full" />
                      )}
                    </div>
                    <span className="text-[9px] font-bold tracking-[0.14em] uppercase font-tight leading-none text-center truncate">
                      {PRESET_LABELS[id]}
                    </span>
                  </button>
                );
              })}
            </div>
            {formation === 'empty' && (
              <p className="text-[11px] text-muted font-tight mt-1">
                Players start parked at midfield. Drag each one where you want them.
              </p>
            )}
          </fieldset>

          {/* Defense toggle */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
              Defense
            </legend>
            <div className="flex items-center gap-2">
              <DefenseOption
                active={!withDefense}
                onSelect={() => setWithDefense(false)}
                label="Offense only"
                sub="7 players · clean board"
              />
              <DefenseOption
                active={withDefense}
                onSelect={() => setWithDefense(true)}
                label="Include defense"
                sub="7v7 · person marks pre-seeded"
              />
            </div>
          </fieldset>
        </div>

        <div className="px-5 py-3 border-t border-hairline flex items-center justify-end gap-2 bg-bg">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-full text-[11px] font-bold tracking-[0.14em] uppercase text-muted hover:text-ink font-tight cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-5 py-2.5 rounded-full bg-accent text-accent-ink text-[11px] font-bold tracking-[0.14em] uppercase font-tight cursor-pointer hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity"
          >
            Create play
          </button>
        </div>
      </form>
    </div>
  );
}

function DefenseOption({
  active,
  onSelect,
  label,
  sub,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={[
        'flex-1 flex items-center gap-3 px-3 py-2.5 rounded-card-sm cursor-pointer transition-shadow text-left bg-bg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'shadow-lift ring-1 ring-accent' : 'shadow-soft hover:shadow-lift',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border-2 transition-colors',
          active ? 'border-accent bg-accent' : 'border-border bg-bg',
        ].join(' ')}
      >
        {active && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 5l2 2 4-4" stroke="rgb(var(--accent-ink))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        <div className="text-[12px] font-bold text-ink font-tight leading-tight">
          {label}
        </div>
        <div className="text-[10px] text-faint font-tight mt-0.5 truncate">
          {sub}
        </div>
      </div>
    </button>
  );
}

// ── icons / previews ─────────────────────────────────────────────────────

function FieldTypeIcon({ type, active }: { type: FieldType; active: boolean }) {
  const stroke = active ? 'rgb(var(--accent))' : 'rgb(var(--muted))';
  const ezFill = active ? 'rgba(255, 255, 255, 0)' : 'rgb(var(--surface-hi))';
  if (type === 'full') {
    return (
      <svg viewBox="0 0 40 60" className="w-10 h-[60px] mx-auto" aria-hidden="true">
        <rect x="1" y="1" width="38" height="58" fill="none" stroke={stroke} strokeWidth="1.5" />
        <rect x="1" y="1" width="38" height="11" fill={ezFill} />
        <rect x="1" y="48" width="38" height="11" fill={ezFill} />
        <line x1="1" y1="12" x2="39" y2="12" stroke={stroke} strokeWidth="0.6" />
        <line x1="1" y1="48" x2="39" y2="48" stroke={stroke} strokeWidth="0.6" />
      </svg>
    );
  }
  if (type === 'half') {
    return (
      <svg viewBox="0 0 40 30" className="w-10 h-[60px] mx-auto" aria-hidden="true">
        <rect x="1" y="1" width="38" height="28" fill="none" stroke={stroke} strokeWidth="1.5" />
        <rect x="1" y="1" width="38" height="9" fill={ezFill} />
        <line x1="1" y1="10" x2="39" y2="10" stroke={stroke} strokeWidth="0.6" />
        <line x1="1" y1="29" x2="39" y2="29" stroke={stroke} strokeWidth="0.6" strokeDasharray="1.5 1.5" />
      </svg>
    );
  }
  // horizontal
  return (
    <svg viewBox="0 0 60 30" className="w-[60px] h-[60px] mx-auto" aria-hidden="true">
      <rect x="1" y="1" width="58" height="28" fill="none" stroke={stroke} strokeWidth="1.5" />
      <rect x="1" y="1" width="11" height="28" fill={ezFill} />
      <rect x="48" y="1" width="11" height="28" fill={ezFill} />
      <line x1="12" y1="1" x2="12" y2="29" stroke={stroke} strokeWidth="0.6" />
      <line x1="48" y1="1" x2="48" y2="29" stroke={stroke} strokeWidth="0.6" />
    </svg>
  );
}

function EmptyPreviewSvg({ active }: { active: boolean }) {
  const fieldBg = active ? 'rgba(255,255,255,0.18)' : 'rgb(var(--surface))';
  const ezBg = active ? 'rgba(255,255,255,0.10)' : 'rgb(var(--surface-hi))';
  const lineCol = active ? 'rgba(255,255,255,0.35)' : 'rgb(var(--hairline))';
  return (
    <svg viewBox="0 0 70 120" preserveAspectRatio="xMidYMid meet" className="w-full h-full" aria-hidden="true">
      <rect x="0" y="0" width="70" height="120" fill={fieldBg} />
      <rect x="0" y="0" width="70" height="25" fill={ezBg} />
      <rect x="0" y="95" width="70" height="25" fill={ezBg} />
      <line x1="0" y1="25" x2="70" y2="25" stroke={lineCol} strokeWidth="0.5" />
      <line x1="0" y1="95" x2="70" y2="95" stroke={lineCol} strokeWidth="0.5" />
      {/* faint "blank canvas" + glyph at centre */}
      <text
        x="35"
        y="65"
        textAnchor="middle"
        fontSize="18"
        fontWeight="700"
        fill={active ? 'rgb(var(--accent-ink))' : 'rgb(var(--faint))'}
        opacity="0.85"
      >
        +
      </text>
    </svg>
  );
}
