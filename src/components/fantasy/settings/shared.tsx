// Shared chrome for the settings/* cards (limits, format, draft, prices) —
// duplicated in miniature from league-settings-panel.tsx's internal Card/
// SaveButton/Feedback rather than exported from there, since that file's
// exports (NameCard/RosterCard/ScoringCard) are load-bearing elsewhere and
// growing its export surface for four new files felt like more coupling than
// four ~15-line components.

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
      <h3 className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

export function SaveButton({
  disabled,
  saving,
  label = 'Save',
  savingLabel = 'Saving…',
}: {
  disabled: boolean;
  saving: boolean;
  label?: string;
  savingLabel?: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={[
        'inline-flex items-center justify-center gap-2',
        'px-5 py-2.5 rounded-full min-h-[44px]',
        'font-tight text-[12px] font-bold tracking-[0.06em] uppercase transition-colors duration-150',
        disabled
          ? 'bg-ink/[0.08] text-faint cursor-not-allowed'
          : 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
      ].join(' ')}
    >
      {saving && (
        <span
          className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin"
          aria-hidden="true"
        />
      )}
      {saving ? savingLabel : label}
    </button>
  );
}

export function Feedback({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) {
    return (
      <p role="alert" className="mt-3 text-[12px] text-live font-tight">
        {error}
      </p>
    );
  }
  if (saved) {
    return (
      <p role="status" className="mt-3 text-[12px] text-muted font-tight">
        Saved.
      </p>
    );
  }
  return null;
}

export function NumberField({
  label,
  value,
  onChange,
  id,
  min = 1,
  max = 20,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  id: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className={[
          'w-20 px-3.5 py-2.5 rounded-card-sm bg-ink/5',
          'font-tight text-[14px] text-ink tabular',
          'focus:outline-none focus:ring-2 focus:ring-accent min-h-[44px]',
        ].join(' ')}
      />
    </div>
  );
}

/** Branded toggle switch — mirrors the pattern in
 *  src/components/settings/notifications-settings.tsx exactly (the only
 *  existing role="switch" in the codebase) so Settings reads as one system. */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={[
        'relative inline-flex items-center flex-shrink-0 w-[42px] h-[26px] rounded-full transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        checked ? 'bg-accent' : 'bg-ink/15',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'inline-block w-[20px] h-[20px] rounded-full bg-surface shadow-card transition-transform duration-150',
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
        ].join(' ')}
      />
    </button>
  );
}
