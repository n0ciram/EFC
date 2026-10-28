/**
 * Panel de ajustes: cristal sobre el escritorio desenfocado, con los ajustes principales agrupados.
 * Cada cambio se envía al momento al proceso principal, que lo valida, lo guarda y lo aplica.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { EASE_IN, prefersReducedMotion, spring, SPRINGS } from '../animations/spring';
import { LANGUAGES, messages, type Language } from '../i18n';
import { PDF_DPI_CHOICES, PHOTO_SIZE_CHOICES, VIDEO_SIZE_CHOICES, type Choice } from '../lib/settings-options';
import { keyToShortcut } from '../lib/shortcut-keys';
import type { EfcApi, SettingsChange, SettingsKey, SettingsState } from '../types/ipc';
import { Icon } from './Icon';

/** Margen transparente alrededor del panel para su sombra (ver settings.css). */
const MARGIN = 20;

export function SettingsPanel({ api }: { api: EfcApi['settings'] }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [localError, setLocalError] = useState<{
    key: SettingsKey;
    message: string;
  } | null>(null);
  const [transparency, setTransparency] = useState(50);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Contenido completo (sin recortar por el desplazamiento): su alto decide el de la ventana. */
  const innerRef = useRef<HTMLDivElement>(null);
  const shownToken = useRef(0);
  const commitTimer = useRef<number | null>(null);

  const openToken = useRef(0);
  const language: Language = state?.values.language ?? 'es';

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(
    () =>
      api.onState((next) => {
        if (next.token !== openToken.current) {
          // Nueva apertura: se empieza de cero.
          openToken.current = next.token;
          setRecording(false);
          setPending(null);
          setLocalError(null);
          setTransparency(next.values.wheelTransparency);
        }
        setState(next);
      }),
    [api],
  );

  // El alto real del contenido decide el de la ventana.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return undefined;
    const report = (): void => api.resize(inner.offsetHeight + MARGIN * 2);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [api, state !== null]);

  // Entrada elástica cada vez que se abre.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !state?.visible || shownToken.current === state.token) return;
    shownToken.current = state.token;
    card.focus({ preventScroll: true });
    if (prefersReducedMotion()) {
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const curve = spring(SPRINGS.toast);
    card.animate(
      [
        { opacity: 0, transform: 'translateY(14px) scale(0.96)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: curve.duration, easing: curve.easing },
    );
  }, [state?.visible, state?.token]);

  // Salida: se desvanece y avisa para ocultar la ventana.
  useEffect(
    () =>
      api.onDismiss(() => {
        const card = cardRef.current;
        if (!card) {
          api.hidden();
          return;
        }
        const reduced = prefersReducedMotion();
        const fade = card.animate(
          [
            { opacity: 1, transform: 'none' },
            {
              opacity: 0,
              transform: reduced ? 'none' : 'translateY(8px) scale(0.98)',
            },
          ],
          {
            duration: reduced ? 80 : 150,
            easing: EASE_IN,
            fill: 'forwards',
          },
        );
        void fade.finished.then(() => {
          api.hidden();
          fade.cancel();
        });
      }),
    [api],
  );

  const set = useCallback(
    (change: SettingsChange) => {
      setLocalError(null);
      api.set(change);
    },
    [api],
  );

  const stopRecording = useCallback(() => {
    setRecording(false);
    setPending(null);
    api.recording(false);
  }, [api]);

  // Grabación del atajo: todas las teclas van al panel mientras dura.
  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keyup') {
        if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) setPending(null);
        return;
      }
      if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        stopRecording();
        return;
      }
      const result = keyToShortcut(e, messages(language));
      if (result.kind === 'pending') setPending(result.label);
      else if (result.kind === 'invalid') {
        setPending(null);
        setLocalError({ key: 'shortcut', message: result.message });
      } else {
        set({ key: 'shortcut', value: result.accelerator });
        stopRecording();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [recording, set, stopRecording, language]);

  if (!state) return <div className="settings-root" />;

  const { values, available } = state;
  const t = messages(language).settings;
  const error = (key: SettingsKey): string | null => (localError?.key === key ? localError.message : state.error?.key === key ? state.error.message : null);
  const backdropStyle: CSSProperties | undefined = state.backdrop
    ? {
        left: state.backdrop.x - MARGIN,
        top: state.backdrop.y - MARGIN,
        width: state.backdrop.width,
        height: state.backdrop.height,
      }
    : undefined;

  const onTransparency = (value: number): void => {
    setTransparency(value);
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => set({ key: 'wheelTransparency', value }), 180);
  };

  return (
    <div
      className="settings-root"
      data-theme={state.theme}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !recording) {
          e.preventDefault();
          api.close();
        }
      }}
    >
      <div className="settings-card" ref={cardRef} tabIndex={-1} role="dialog" aria-label={t.dialog} data-fallback={state.backdrop ? 'false' : 'true'}>
        <div className="settings-glass" aria-hidden="true">
          {state.backdrop && <img className="settings-backdrop" src={state.backdrop.dataUrl} alt="" draggable={false} style={backdropStyle} />}
          <div className="settings-tint" />
        </div>

        <div className="settings-content">
          <div className="settings-inner" ref={innerRef}>
            <header className="settings-header">
              <div>
                <h1 className="settings-title">{t.title}</h1>
                <p className="settings-version">EFC {state.version}</p>
              </div>
              <button type="button" className="settings-close" aria-label={t.close} onClick={() => api.close()}>
                <Icon name="close" size={16} />
              </button>
            </header>

            <Section title={t.general}>
              <Row
                label={t.shortcut}
                hint={recording ? t.shortcutRecording : state.shortcutOk ? t.shortcutHint : t.shortcutBusyHint}
                error={error('shortcut')}
              >
                <button
                  type="button"
                  className="settings-keycap"
                  data-recording={recording ? 'true' : 'false'}
                  aria-label={recording ? t.shortcutAriaRecording : t.shortcutAria(state.shortcutLabel)}
                  onClick={() => {
                    if (recording) {
                      stopRecording();
                      return;
                    }
                    setLocalError(null);
                    setRecording(true);
                    api.recording(true);
                  }}
                >
                  {recording ? (pending ?? t.shortcutPress) : state.shortcutLabel}
                </button>
              </Row>
              <Row label={t.launchAtLogin} hint={available.launchAtLogin ? undefined : t.installedOnly} disabled={!available.launchAtLogin}>
                <Switch label={t.launchAtLogin} checked={values.launchAtLogin} disabled={!available.launchAtLogin} onChange={(v) => set({ key: 'launchAtLogin', value: v })} />
              </Row>
              <Row
                label={t.contextMenu}
                hint={available.contextMenu ? undefined : t.installedOnly}
                disabled={!available.contextMenu}
                error={error('contextMenu')}
              >
                <Switch
                  label={t.contextMenu}
                  checked={values.contextMenu}
                  disabled={!available.contextMenu}
                  onChange={(v) => set({ key: 'contextMenu', value: v })}
                />
              </Row>
              <Row label={t.language} hint={t.languageHint}>
                <Segmented label={t.language} choices={LANGUAGES} value={values.language} onChange={(v) => set({ key: 'language', value: v })} />
              </Row>
            </Section>

            <Section title={t.appearance}>
              <Row label={t.blur} hint={t.blurHint}>
                <Switch label={t.blur} checked={values.backdropBlur} onChange={(v) => set({ key: 'backdropBlur', value: v })} />
              </Row>
              <Row label={t.transparency} stacked>
                <div className="settings-slider">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={transparency}
                    aria-label={t.transparency}
                    aria-valuetext={messages(language).percent(transparency)}
                    style={{ '--value': `${transparency}%` } as CSSProperties}
                    onChange={(e) => onTransparency(Number(e.currentTarget.value))}
                  />
                  <div className="settings-slider-scale" aria-hidden="true">
                    <span>{t.moreOpaque}</span>
                    <span>{t.moreTransparent}</span>
                  </div>
                </div>
              </Row>
              <Row
                label={t.hideInCaptures}
                hint={available.captureExclusion ? t.hideInCapturesHint : t.hideInCapturesUnavailable}
                disabled={!available.captureExclusion}
              >
                <Switch
                  label={t.hideInCaptures}
                  checked={values.excludeFromScreenCapture}
                  disabled={!available.captureExclusion}
                  onChange={(v) => set({ key: 'excludeFromScreenCapture', value: v })}
                />
              </Row>
            </Section>

            <Section title={t.quality}>
              <Row label={t.imageQuality} hint={t.imageQualityHint} stacked>
                <Segmented
                  label={t.imageQuality}
                  choices={[
                    { value: 'max', label: t.qualityMax },
                    { value: 'high', label: t.qualityHigh },
                    { value: 'balanced', label: t.qualityBalanced },
                  ]}
                  value={values.imageQuality === 'custom' ? null : values.imageQuality}
                  custom={values.imageQuality === 'custom' ? t.qualityCustom : null}
                  customTitle={t.customValue}
                  onChange={(v) => set({ key: 'imageQuality', value: v })}
                />
              </Row>
              <Row label={t.pdfDpi} hint={t.pdfDpiHint}>
                <Segmented label={t.pdfDpiAria} customTitle={t.customValue} choices={PDF_DPI_CHOICES} value={values.pdfDpi} onChange={(v) => set({ key: 'pdfDpi', value: v })} />
              </Row>
              <Row label={t.shrinkPhotos} hint={t.shrinkPhotosHint}>
                <Segmented label={t.shrinkPhotosAria} customTitle={t.customValue} choices={PHOTO_SIZE_CHOICES} value={values.shrinkMaxSide} onChange={(v) => set({ key: 'shrinkMaxSide', value: v })} />
              </Row>
              <Row label={t.shrinkVideos} hint={t.shrinkVideosHint}>
                <Segmented
                  label={t.shrinkVideosAria}
                  customTitle={t.customValue}
                  choices={VIDEO_SIZE_CHOICES}
                  value={values.shrinkVideoMaxSide}
                  onChange={(v) => set({ key: 'shrinkVideoMaxSide', value: v })}
                />
              </Row>
            </Section>

            <footer className="settings-footer">{state.status}</footer>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2 className="settings-section-title">{title}</h2>
      <div className="settings-group">{children}</div>
    </section>
  );
}

interface RowProps {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  disabled?: boolean;
  /** El control va debajo del texto, a todo el ancho. */
  stacked?: boolean;
  children: ReactNode;
}

function Row({ label, hint, error, disabled = false, stacked = false, children }: RowProps) {
  return (
    <div className="settings-row" data-stacked={stacked ? 'true' : 'false'} data-disabled={disabled ? 'true' : 'false'}>
      <div className="settings-row-text">
        <span className="settings-label">{label}</span>
        {hint && !error && <span className="settings-hint">{hint}</span>}
        {error && (
          <span className="settings-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </span>
        )}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Switch({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="settings-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="settings-switch-knob" />
    </button>
  );
}

interface SegmentedProps<T> {
  label: string;
  choices: readonly Choice<T>[];
  value: T | null;
  /** Valor editado a mano en config.json que no es ninguna de las opciones (se muestra como elegido). */
  custom?: string | null;
  /** Explicación del valor personalizado (al pasar el ratón). */
  customTitle?: string;
  onChange(value: T): void;
}

function Segmented<T extends string | number>({ label, choices, value, custom = null, customTitle, onChange }: SegmentedProps<T>) {
  const known = choices.some((c) => c.value === value);
  const customLabel = custom ?? (value !== null && !known ? String(value) : null);
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button
          key={String(c.value)}
          type="button"
          role="radio"
          aria-checked={c.value === value}
          className="settings-segment"
          onClick={() => {
            if (c.value !== value) onChange(c.value);
          }}
        >
          {c.label}
        </button>
      ))}
      {customLabel && (
        <span className="settings-segment" role="radio" aria-checked="true" aria-disabled="true" title={customTitle}>
          {customLabel}
        </span>
      )}
    </div>
  );
}
