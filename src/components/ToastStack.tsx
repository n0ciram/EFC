/**
 * Pila de notificaciones de progreso (tarjetas de cristal horizontales).
 *
 * - La barra refleja el progreso real; si el motor no puede medirlo, se usa un indicador indeterminado.
 * - Éxito y error se distinguen por el icono, el texto y la opacidad, nunca por colores llamativos.
 * - Las tarjetas que se van se desvanecen y su hueco se cierra suavemente.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { EASE_IN, prefersReducedMotion, spring, SPRINGS } from '../animations/spring';
import type { EfcApi, ToastAction, ToastItem, ToastState, WheelBackdrop } from '../types/ipc';
import { DEFAULT_LANGUAGE, messages, type Language } from '../i18n';
import { Icon } from './Icon';

interface Rendered {
  item: ToastItem;
  exiting: boolean;
}

export function ToastStack({ api }: { api: EfcApi['toast'] }) {
  const [theme, setTheme] = useState<ToastState['theme']>('light');
  const [backdrop, setBackdrop] = useState<WheelBackdrop | null>(null);
  const [language, setLanguage] = useState<Language>(DEFAULT_LANGUAGE);
  const [rendered, setRendered] = useState<Rendered[]>([]);
  const stackRef = useRef<HTMLDivElement>(null);
  const hiddenSent = useRef(true);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(
    () =>
      api.onState((state) => {
        setTheme(state.theme);
        setBackdrop(state.backdrop);
        setLanguage(state.language);
        setRendered((previous) => {
          const incoming = new Map(state.items.map((i) => [i.id, i]));
          const next: Rendered[] = previous.map((r) => {
            const updated = incoming.get(r.item.id);
            return updated ? { item: updated, exiting: false } : { item: r.item, exiting: true };
          });
          for (const item of state.items) {
            if (!previous.some((r) => r.item.id === item.id)) next.push({ item, exiting: false });
          }
          return next;
        });
        if (state.items.length > 0) hiddenSent.current = false;
      }),
    [api],
  );

  const removeExited = useCallback((id: string) => {
    setRendered((previous) => previous.filter((r) => r.item.id !== id || !r.exiting));
  }, []);

  // Cuando no queda nada visible, el proceso principal puede ocultar la ventana.
  useEffect(() => {
    if (rendered.length === 0 && !hiddenSent.current) {
      hiddenSent.current = true;
      api.setInteractive(false);
      api.hidden();
    }
  }, [api, rendered.length]);

  // Ajusta la altura de la ventana al contenido.
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const report = (): void => api.resize(Math.ceil(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api]);

  return (
    <div className="toast-root" data-theme={theme}>
      <div className="toast-stack" ref={stackRef} role="status" aria-live="polite">
        {rendered.map(({ item, exiting }) => (
          <ToastCard key={item.id} item={item} exiting={exiting} backdrop={backdrop} labels={messages(language).toast.actions} api={api} onExited={removeExited} />
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  item: ToastItem;
  exiting: boolean;
  backdrop: WheelBackdrop | null;
  /** Texto de cada botón en el idioma de la interfaz. */
  labels: Record<ToastAction, string>;
  api: EfcApi['toast'];
  onExited(id: string): void;
}

function ToastCard({ item, exiting, backdrop, labels, api, onExited }: CardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previousIcon = useRef(item.icon);

  // Entrada elástica.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (prefersReducedMotion()) {
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'backwards' });
      return;
    }
    const curve = spring(SPRINGS.toast);
    card.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(0.94)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: curve.duration, easing: curve.easing, fill: 'backwards' },
    );
  }, []);

  // Cambio de icono (p. ej. de formato a ✓): pequeño «pop».
  useEffect(() => {
    if (previousIcon.current === item.icon) return;
    previousIcon.current = item.icon;
    const el = iconRef.current;
    if (!el || prefersReducedMotion()) return;
    const curve = spring(SPRINGS.settle);
    el.animate([{ transform: 'scale(0.55)', opacity: 0.2 }, { transform: 'scale(1)', opacity: 1 }], { duration: curve.duration, easing: curve.easing });
  }, [item.icon]);

  // Salida: se desvanece y después se cierra su hueco.
  useEffect(() => {
    if (!exiting) return;
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (!wrap || !card) {
      onExited(item.id);
      return;
    }
    const reduced = prefersReducedMotion();
    const fade = card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: reduced ? 'none' : 'translateY(-4px) scale(0.97)' }], {
      duration: reduced ? 90 : 170,
      easing: EASE_IN,
      fill: 'forwards',
    });
    let cancelled = false;
    void fade.finished
      .then(() => {
        if (cancelled) return undefined;
        const height = wrap.getBoundingClientRect().height;
        return wrap.animate([{ height: `${height}px` }, { height: '0px' }], { duration: reduced ? 1 : 180, easing: 'ease-in-out', fill: 'forwards' }).finished;
      })
      .then(() => {
        if (!cancelled) onExited(item.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [exiting, item.id, onExited]);

  // Posición de la tarjeta en la ventana, para alinear el escritorio desenfocado.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let x = 0;
    let y = 0;
    let el: HTMLElement | null = card;
    while (el) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    if (x !== offset.x || y !== offset.y) setOffset({ x, y });
  });

  const act = (action: ToastAction): void => api.action(item.id, action);
  const running = item.status === 'running';
  const indeterminate = running && item.progress === null;
  const progress = item.status === 'done' ? 1 : (item.progress ?? 0);
  const clickable = item.actions.includes('reveal');
  // Un único botón visible para no recortar el texto: reintentar tiene prioridad; «Mostrar» también
  // está disponible haciendo clic en la tarjeta.
  const primary: ToastAction | null = item.actions.includes('retry') ? 'retry' : item.actions.includes('reveal') ? 'reveal' : null;

  const backdropStyle: CSSProperties | undefined = backdrop
    ? { left: backdrop.x - offset.x, top: backdrop.y - offset.y, width: backdrop.width, height: backdrop.height }
    : undefined;

  return (
    <div className="toast-wrap" ref={wrapRef}>
      <div
        className="toast-card"
        ref={cardRef}
        data-status={item.status}
        data-clickable={clickable ? 'true' : 'false'}
        data-fallback={backdrop ? 'false' : 'true'}
        onPointerEnter={() => api.setInteractive(true)}
        onPointerLeave={() => api.setInteractive(false)}
        onClick={(e) => {
          if (clickable && !(e.target as HTMLElement).closest('button')) act('reveal');
        }}
      >
        <div className="toast-glass" aria-hidden="true">
          {backdrop && <img className="toast-backdrop" src={backdrop.dataUrl} alt="" draggable={false} style={backdropStyle} />}
          <div className="toast-tint" />
        </div>

        <span className="toast-icon" ref={iconRef}>
          <Icon name={item.icon} size={18} />
        </span>

        <div className="toast-text">
          <div className="toast-title">{item.title}</div>
          <div className="toast-detail" title={item.detail}>
            {item.detail}
          </div>
          {item.meta && <div className="toast-meta">{item.meta}</div>}
        </div>

        <div className="toast-actions">
          {primary && (
            <button type="button" className="toast-button" onClick={() => act(primary)}>
              {labels[primary]}
            </button>
          )}
          {item.actions
            .filter((a) => a === 'cancel' || a === 'dismiss')
            .map((a) => (
              <button key={a} type="button" className="toast-close" aria-label={labels[a]} title={labels[a]} onClick={() => act(a)}>
                <Icon name="close" size={14} />
              </button>
            ))}
        </div>

        {(running || item.status === 'done') && (
          <div
            className="toast-progress"
            data-indeterminate={indeterminate ? 'true' : 'false'}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : Math.round(progress * 100)}
          >
            <div className="toast-progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${Math.max(0.02, progress)})` }} />
          </div>
        )}
      </div>
    </div>
  );
}
