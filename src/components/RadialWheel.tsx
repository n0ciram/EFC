/**
 * Rueda radial de conversión.
 *
 * Interacción: cursor (pasar por encima, clic o arrastrar desde el centro y soltar sobre un pétalo),
 * teclado (flechas, Tab, Intro, 1–8, Esc) y lectores de pantalla (menú con elemento activo).
 * Fuera del círculo la ventana deja pasar el ratón: un clic fuera llega a la aplicación de debajo
 * y la rueda se cierra.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { animateClose, animateCommit, animateOpen, animatePetalsIn, animatePetalsOut, pulse, resetWheel, type WheelParts } from '../animations/wheel-motion';
import { prefersReducedMotion } from '../animations/spring';
import { hitTest, petalPath, polar, sectorCenterAngle, wheelGeometry, type HitResult } from '../lib/geometry';
import { DEFAULT_LANGUAGE, messages } from '../i18n';
import { DEFAULT_WHEEL_TRANSPARENCY, glassFactor } from '../lib/settings-options';
import type { EfcApi, WheelCloseReason, WheelState } from '../types/ipc';
import { CenterOrb } from './CenterOrb';
import { Icon } from './Icon';
import { paginate, type PetalItem } from './pagination';

type Mode = 'hidden' | 'ready' | 'open' | 'leaving';

const LIFT = 5; // px que se desplaza hacia fuera el pétalo activo
const PARALLAX = 3; // px máximos que el icono sigue al cursor

interface Props {
  api: EfcApi['wheel'];
}

/** Coloca la captura del escritorio exactamente donde está en pantalla y amplía desde el centro (efecto lente). */
function backdropStyle(state: WheelState, diameter: number): CSSProperties {
  const backdrop = state.backdrop;
  if (!backdrop) return {};
  const left = backdrop.x - (window.innerWidth - diameter) / 2;
  const top = backdrop.y - (window.innerHeight - diameter) / 2;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${backdrop.width}px`,
    height: `${backdrop.height}px`,
    transformOrigin: `${diameter / 2 - left}px ${diameter / 2 - top}px`,
  };
}

export function RadialWheel({ api }: Props) {
  const [state, setState] = useState<WheelState | null>(null);
  const [mode, setMode] = useState<Mode>('hidden');
  const [page, setPage] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [focusVisible, setFocusVisible] = useState(false);
  const [pressed, setPressed] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLImageElement>(null);
  const rimRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const petalRefs = useRef<(HTMLDivElement | null)[]>([]);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);

  const tokenRef = useRef(0);
  const leavingRef = useRef(false);
  const interactiveRef = useRef(true);
  const downRef = useRef<HitResult | null>(null);
  const parallaxFrame = useRef(0);

  const diameter = state?.diameter ?? 300;
  const geometry = useMemo(() => wheelGeometry(diameter), [diameter]);
  const center = diameter / 2;
  const m = messages(state?.language ?? DEFAULT_LANGUAGE);
  useEffect(() => {
    document.documentElement.lang = state?.language ?? DEFAULT_LANGUAGE;
  }, [state?.language]);
  const pages = useMemo(() => (state ? paginate(state.targets, undefined, messages(state.language)) : []), [state]);
  const items: PetalItem[] = pages[page] ?? [];
  const count = items.length;

  const parts = useCallback((): WheelParts | null => {
    const { current: shadow } = shadowRef;
    const { current: glass } = glassRef;
    const { current: rim } = rimRef;
    const { current: body } = bodyRef;
    const { current: orb } = orbRef;
    if (!shadow || !glass || !rim || !body || !orb) return null;
    return {
      shadow,
      glass,
      backdrop: backdropRef.current,
      rim,
      body,
      orb,
      notice: noticeRef.current,
      petals: petalRefs.current.slice(0, count).filter((p): p is HTMLDivElement => p !== null),
    };
  }, [count]);

  const setInteractive = useCallback(
    (value: boolean) => {
      if (interactiveRef.current === value) return;
      interactiveRef.current = value;
      api.setInteractive(value);
    },
    [api],
  );

  /** Sale con animación y avisa al proceso principal para ocultar la ventana. */
  const leave = useCallback(
    (kind: 'close' | 'commit', index = -1) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      // La salida pertenece a esta apertura: si la rueda se vuelve a abrir antes de que termine la
      // animación, el aviso de «cerrada» no debe afectar a la apertura nueva.
      const token = tokenRef.current;
      const p = parts();
      const reduced = prefersReducedMotion();
      setMode('leaving');
      const animation = p ? (kind === 'commit' ? animateCommit(p, geometry.outer, index, reduced) : animateClose(p, geometry.outer, reduced)) : Promise.resolve();
      void animation.then(() => {
        api.closed(token);
        if (tokenRef.current !== token) return;
        setMode('hidden');
        setHover(null);
        setPressed(null);
      });
    },
    [api, geometry.outer, parts],
  );

  const requestClose = useCallback(
    (reason: WheelCloseReason) => {
      if (leavingRef.current) return;
      api.requestClose(tokenRef.current, reason);
      leave('close');
    },
    [api, leave],
  );

  // Suscripción a los eventos del proceso principal.
  useEffect(() => {
    const offOpen = api.onOpen((next) => {
      const current = parts();
      if (current) resetWheel(current);
      flushSync(() => {
        setState(next);
        setMode('ready');
        setPage(0);
        setHover(null);
        setFocusIndex(null);
        setFocusVisible(false);
        setPressed(null);
        setSwitching(false);
      });
      tokenRef.current = next.token;
      leavingRef.current = false;
      interactiveRef.current = true;
      downRef.current = null;
      api.ready(next.token);
    });
    const offPlay = api.onPlay((token) => {
      if (token === tokenRef.current) setMode('open');
    });
    const offDismiss = api.onDismiss(() => leave('close'));
    return () => {
      offOpen();
      offPlay();
      offDismiss();
    };
  }, [api, leave, parts]);

  // Animación de apertura en el mismo fotograma en que la rueda se hace visible.
  useLayoutEffect(() => {
    if (mode !== 'open') return;
    const p = parts();
    if (p) void animateOpen(p, geometry.outer, prefersReducedMotion());
    rootRef.current?.focus({ preventScroll: true });
  }, [mode, parts, geometry.outer]);

  const changePage = useCallback(
    (next: number) => {
      if (switching || next < 0 || next >= pages.length || next === page) return;
      const direction: 1 | -1 = next > page ? 1 : -1;
      const reduced = prefersReducedMotion();
      setSwitching(true);
      const current = parts();
      void animatePetalsOut(current?.petals ?? [], direction, reduced).then(() => {
        flushSync(() => {
          setPage(next);
          setHover(null);
          setFocusIndex(focusVisible ? 0 : null);
        });
        const after = parts();
        void animatePetalsIn(after?.petals ?? [], direction, reduced).then(() => setSwitching(false));
      });
    },
    [focusVisible, page, pages.length, parts, switching],
  );

  const activate = useCallback(
    (index: number) => {
      if (mode !== 'open' || switching || !state) return;
      const item = items[index];
      if (!item) return;
      if (item.kind === 'more' || item.kind === 'back' || item.kind === 'group') {
        changePage(item.to);
        return;
      }
      api.choose(tokenRef.current, item.target.id);
      leave('commit', index);
    },
    [api, changePage, items, leave, mode, page, state, switching],
  );

  // --- Puntero -------------------------------------------------------------------------------------

  const localHit = useCallback(
    (e: PointerEvent<HTMLDivElement>): HitResult => {
      const body = bodyRef.current;
      if (!body) return { kind: 'outside' };
      const rect = body.getBoundingClientRect();
      // Las coordenadas se normalizan por si la rueda está escalada durante una animación.
      const scale = rect.width / diameter || 1;
      return hitTest((e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale, center, center, geometry, count);
    },
    [center, count, diameter, geometry],
  );

  const updateParallax = useCallback(
    (index: number | null, clientX: number, clientY: number) => {
      cancelAnimationFrame(parallaxFrame.current);
      parallaxFrame.current = requestAnimationFrame(() => {
        labelRefs.current.forEach((label, i) => {
          if (!label) return;
          if (i !== index || prefersReducedMotion()) {
            label.style.setProperty('--px', '0px');
            label.style.setProperty('--py', '0px');
            return;
          }
          const rect = label.getBoundingClientRect();
          const dx = clientX - (rect.left + rect.width / 2);
          const dy = clientY - (rect.top + rect.height / 2);
          const len = Math.hypot(dx, dy) || 1;
          const amount = Math.min(PARALLAX, len / 12);
          label.style.setProperty('--px', `${((dx / len) * amount).toFixed(2)}px`);
          label.style.setProperty('--py', `${((dy / len) * amount).toFixed(2)}px`);
        });
      });
    },
    [],
  );

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (mode !== 'open' && mode !== 'ready') return;
    const hit = localHit(e);
    setInteractive(hit.kind !== 'outside');
    const index = hit.kind === 'sector' ? hit.index : null;
    if (index !== hover) {
      setHover(index);
      if (index !== null) setFocusVisible(false);
    }
    updateParallax(index, e.clientX, e.clientY);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (mode !== 'open' || e.button !== 0) return;
    const hit = localHit(e);
    downRef.current = hit;
    if (hit.kind === 'outside') {
      requestClose('outside');
      return;
    }
    if (hit.kind === 'sector') setPressed(hit.index);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const down = downRef.current;
    downRef.current = null;
    setPressed(null);
    if (mode !== 'open' || !down || e.button !== 0) return;
    const up = localHit(e);
    if (up.kind === 'sector') {
      // Clic sobre el mismo pétalo, o gesto «arrastrar desde el centro y soltar».
      if ((down.kind === 'sector' && down.index === up.index) || down.kind === 'center') activate(up.index);
      return;
    }
    if (up.kind === 'center' && down.kind === 'center') requestClose('outside');
  };

  const onPointerLeave = (): void => {
    setHover(null);
    updateParallax(null, 0, 0);
  };

  // --- Teclado -------------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (mode !== 'open') return;
    const current = focusIndex ?? hover;
    const move = (delta: number): void => {
      e.preventDefault();
      setFocusVisible(true);
      setHover(null);
      setFocusIndex(current === null ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count);
    };
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (page > 0) changePage(0);
        else requestClose('escape');
        return;
      case 'ArrowRight':
      case 'ArrowDown':
        move(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        move(-1);
        return;
      case 'Tab':
        move(e.shiftKey ? -1 : 1);
        return;
      case 'Home':
        e.preventDefault();
        setFocusVisible(true);
        setFocusIndex(0);
        return;
      case 'End':
        e.preventDefault();
        setFocusVisible(true);
        setFocusIndex(count - 1);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (current !== null) {
          const el = petalRefs.current[current];
          if (el) pulse(el);
          activate(current);
        }
        return;
      default:
        if (/^[1-8]$/.test(e.key)) {
          const index = Number(e.key) - 1;
          if (index < count) {
            e.preventDefault();
            activate(index);
          }
        }
    }
  };

  // --- Presentación ----------------------------------------------------------------------------------

  const active = focusVisible ? focusIndex : hover;
  const activeItem = active !== null ? (items[active] ?? null) : null;
  const step = count > 0 ? 360 / count : 360;

  const petals = useMemo(
    () =>
      items.map((item, i) => {
        const angle = sectorCenterAngle(i, count);
        const path = petalPath(center, center, geometry, angle - step / 2, angle + step / 2);
        const labelRadius = count === 1 ? (geometry.petalInner + geometry.petalOuter) / 2 : geometry.petalInner + (geometry.petalOuter - geometry.petalInner) * 0.52;
        const labelPos = polar(center, center, labelRadius, angle);
        // Con un único destino el pétalo es el anillo completo: desplazarlo lo descentraría del disco.
        const lift = count === 1 ? { x: 0, y: 0 } : polar(0, 0, LIFT, angle);
        const marker = polar(center, center, geometry.petalOuter - 10, angle);
        return { item, i, angle, path, labelPos, lift, marker };
      }),
    [center, count, geometry, items, step],
  );

  if (!state) return <div className="wheel" data-mode="hidden" />;

  const wheelStyle = { '--d': `${diameter}px`, '--glass-factor': glassFactor(state.transparency ?? DEFAULT_WHEEL_TRANSPARENCY) } as CSSProperties;
  const activeId = active !== null ? `petal-${page}-${active}` : undefined;
  const fallback = state.backdrop === null;

  return (
    <div
      ref={rootRef}
      className="wheel"
      data-mode={mode}
      data-theme={state.theme}
      data-fallback={fallback ? 'true' : 'false'}
      data-hovering={active !== null ? 'true' : 'false'}
      style={wheelStyle}
      role="menu"
      aria-label={m.wheel.convert(state.title)}
      aria-activedescendant={activeId}
      tabIndex={0}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <svg className="wheel-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="efc-petal-sheen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0.08" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>

      <div className="wheel-stage">
        <div className="wheel-shadow" ref={shadowRef} />
        <div className="wheel-glass" ref={glassRef}>
          {state.backdrop && (
            <img
              ref={backdropRef}
              className="wheel-backdrop"
              src={state.backdrop.dataUrl}
              alt=""
              draggable={false}
              style={backdropStyle(state, diameter)}
            />
          )}
          <div className="wheel-tint" />
          <div className="wheel-grain" />
        </div>
        <div className="wheel-rim" ref={rimRef} />

        <div className="wheel-body" ref={bodyRef}>
          {petals.map(({ item, i, path, labelPos, lift, marker }) => {
            const isActive = active === i;
            const label = item.kind === 'target' ? item.target.label : item.kind === 'group' ? item.info.label || item.info.caption : item.kind === 'more' ? m.wheel.more : m.wheel.back;
            const icon = item.kind === 'target' ? item.target.icon : item.kind === 'group' ? item.info.icon : item.kind;
            return (
              <div
                key={`${page}-${item.key}`}
                id={`petal-${page}-${i}`}
                ref={(el) => {
                  petalRefs.current[i] = el;
                }}
                className="petal"
                role="menuitem"
                aria-label={
                  item.kind === 'target'
                    ? `${item.target.label}: ${item.target.description}`
                    : item.kind === 'group'
                      ? `${item.info.caption} ${item.info.label}: ${item.info.description}`
                      : label
                }
                data-kind={item.kind}
                data-caption-only={item.kind === 'group' && !item.info.label ? 'true' : undefined}
                data-active={isActive ? 'true' : 'false'}
                data-pressed={pressed === i ? 'true' : 'false'}
                data-focus-visible={focusVisible && focusIndex === i ? 'true' : 'false'}
                style={{ '--lift-x': `${lift.x.toFixed(2)}px`, '--lift-y': `${lift.y.toFixed(2)}px` } as CSSProperties}
              >
                <svg className="petal-svg" viewBox={`0 0 ${diameter} ${diameter}`} aria-hidden="true" focusable="false">
                  <path className="petal-shape" d={path} />
                  <path className="petal-sheen" d={path} />
                  {item.kind === 'target' && item.recommended && count > 1 && <circle className="petal-marker" cx={marker.x} cy={marker.y} r={2} />}
                </svg>
                <div
                  className="petal-label"
                  ref={(el) => {
                    labelRefs.current[i] = el;
                  }}
                  style={{ left: `${labelPos.x}px`, top: `${labelPos.y}px` }}
                >
                  <Icon name={icon} size={19} className="petal-icon" />
                  {item.kind === 'group' && item.info.label && <span className="petal-caption">{item.info.caption}</span>}
                  <span className="petal-text">{label}</span>
                </div>
              </div>
            );
          })}

          <div className="wheel-well" />
          <CenterOrb ref={orbRef} state={state} active={activeItem} orbRadius={geometry.orb} />
        </div>
      </div>

      {state.notice && (
        <div className="wheel-notice" ref={noticeRef} role="note">
          {state.notice}
        </div>
      )}
    </div>
  );
}
