/**
 * Esfera central: identifica el archivo seleccionado (nombre abreviado sin deformar el círculo,
 * formato y tamaño) y, al pasar el cursor por un pétalo, muestra el destino.
 */
import { forwardRef, useMemo } from 'react';
import { messages } from '../i18n';
import { fitLines } from '../lib/text';
import type { WheelState } from '../types/ipc';
import type { PetalItem } from './pagination';

/** Destinos que son acciones y no formatos: la esfera no dice «JPG a REDUCIR». */
const ACTIONS: ReadonlySet<string> = new Set(['pdf-merge', 'shrink', 'pdf-split', 'pdf-rotate']);

export const ORB_NAME_FONT = '500 11.5px "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif';

interface CenterOrbProps {
  state: WheelState;
  active: PetalItem | null;
  orbRadius: number;
}

export const CenterOrb = forwardRef<HTMLDivElement, CenterOrbProps>(function CenterOrb({ state, active, orbRadius }, ref) {
  // Anchura disponible en cada línea según su altura dentro del círculo.
  const lines = useMemo(() => {
    const chord = (dy: number): number => 2 * Math.sqrt(Math.max(0, orbRadius * orbRadius - dy * dy)) - 16;
    return fitLines(state.title, [chord(4), chord(18)], ORB_NAME_FONT);
  }, [state.title, orbRadius]);

  const m = messages(state.language);
  const showTarget = active !== null;
  let targetLabel = '';
  let targetDetail = '';
  let fromText = '\u00a0';
  if (active?.kind === 'target') {
    targetLabel = active.target.label;
    targetDetail = active.target.description;
    if (!ACTIONS.has(active.target.id)) fromText = m.wheel.from(state.sourceLabel);
  } else if (active?.kind === 'group') {
    fromText = active.info.label ? active.info.caption : '\u00a0';
    targetLabel = active.info.label || active.info.caption;
    targetDetail = active.info.description;
  } else if (active?.kind === 'more') {
    targetLabel = m.wheel.more;
    targetDetail = m.wheel.moreDetail;
  } else if (active?.kind === 'back') {
    targetLabel = m.wheel.back;
    targetDetail = m.wheel.backDetail;
  }

  return (
    <div className="orb" ref={ref} data-show-target={showTarget ? 'true' : 'false'}>
      <div className="orb-face orb-source" aria-hidden={showTarget}>
        <span className="orb-badge">{state.sourceLabel}</span>
        <span className="orb-name" title={state.title}>
          {lines.map((line, i) => (
            <span key={i} className="orb-name-line">
              {line}
            </span>
          ))}
        </span>
        <span className="orb-size">{state.sizeLabel}</span>
      </div>
      <div className="orb-face orb-target" aria-hidden={!showTarget}>
        <span className="orb-from">{fromText}</span>
        <span className="orb-target-label" data-long={targetLabel.length > 7 ? 'true' : undefined}>
          {targetLabel}
        </span>
        <span className="orb-target-detail">{targetDetail}</span>
      </div>
    </div>
  );
});
