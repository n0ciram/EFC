/**
 * Reparto de destinos en «páginas» de la rueda: como máximo 8 pétalos por página.
 *
 * - Si hay más destinos, el último pétalo lleva a la página siguiente («Más») y la siguiente empieza
 *   con «Volver».
 * - Los destinos de un grupo (p. ej. las herramientas de PDF) no ocupan la rueda principal: se
 *   muestran con un único pétalo que abre su propia página, también con «Volver».
 *
 * Cada elemento de navegación indica a qué página lleva (`to`).
 */
import type { IconId } from '../types/formats';
import type { Messages } from '../i18n';
import { es } from '../i18n/es';
import type { TargetGroup, WheelTarget } from '../types/ipc';

export interface GroupInfo {
  /** Texto principal del pétalo (vacío: solo se muestra el texto pequeño). */
  label: string;
  /** Texto pequeño (encima del principal, o solo si no hay principal). */
  caption: string;
  /** Descripción para la esfera central. */
  description: string;
  icon: IconId;
}

/** Pétalo de cada grupo de herramientas, en el idioma de la interfaz. */
export function groupInfo(group: TargetGroup, m: Messages): GroupInfo {
  return group === 'pdf-tools'
    ? { label: 'PDF', caption: m.wheel.tools, description: m.wheel.pdfToolsDetail, icon: 'toolbox' }
    : { label: '', caption: m.wheel.tools, description: m.wheel.imageToolsDetail, icon: 'toolbox' };
}

export type PetalItem =
  | { kind: 'target'; key: string; target: WheelTarget; recommended: boolean }
  | { kind: 'more'; key: 'more'; to: number }
  | { kind: 'back'; key: 'back'; to: number }
  | { kind: 'group'; key: string; group: TargetGroup; info: GroupInfo; to: number };

export const MAX_PETALS = 8;

type Entry = { kind: 'target'; target: WheelTarget } | { kind: 'group'; group: TargetGroup };

/** Reparte `entries` en páginas a partir del índice `firstPage`, con «Más»/«Volver» entre ellas. */
function layout(entries: Entry[], firstPage: number, backTo: number | null, maxPetals: number, recommendFirst: boolean, m: Messages): PetalItem[][] {
  const pages: PetalItem[][] = [];
  let rest = entries.slice();
  let pageIndex = firstPage;
  let first = true;
  while (rest.length > 0 || first) {
    const nav: PetalItem[] = [];
    if (!first) nav.push({ kind: 'back', key: 'back', to: pageIndex - 1 });
    else if (backTo !== null) nav.push({ kind: 'back', key: 'back', to: backTo });
    const capacity = maxPetals - nav.length;
    const fits = rest.length <= capacity;
    const take = fits ? rest.length : capacity - 1;
    const items: PetalItem[] = rest.slice(0, take).map((e, i) =>
      e.kind === 'target'
        ? { kind: 'target', key: e.target.id, target: e.target, recommended: recommendFirst && first && i === 0 }
        : { kind: 'group', key: `group-${e.group}`, group: e.group, info: groupInfo(e.group, m), to: -1 },
    );
    pages.push([...nav, ...items, ...(fits ? [] : [{ kind: 'more', key: 'more', to: pageIndex + 1 } as PetalItem])]);
    rest = rest.slice(take);
    pageIndex++;
    first = false;
    if (fits) break;
  }
  return pages;
}

export function paginate(targets: readonly WheelTarget[], maxPetals = MAX_PETALS, m: Messages = es): PetalItem[][] {
  // Rueda principal: primero los formatos; los grupos de herramientas, al final de la primera página
  // (siempre visibles, aunque los formatos que no caben pasen a «Más»).
  const formats: Entry[] = [];
  const groups: Entry[] = [];
  const members = new Map<TargetGroup, WheelTarget[]>();
  for (const t of targets) {
    if (!t.group) {
      formats.push({ kind: 'target', target: t });
      continue;
    }
    if (!members.has(t.group)) {
      members.set(t.group, []);
      groups.push({ kind: 'group', group: t.group });
    }
    (members.get(t.group) as WheelTarget[]).push(t);
  }

  let pages: PetalItem[][];
  if (formats.length + groups.length <= maxPetals) {
    pages = layout([...formats, ...groups], 0, null, maxPetals, true, m);
  } else {
    const take = Math.max(0, maxPetals - 1 - groups.length);
    const first = layout([...formats.slice(0, take), ...groups], 0, null, maxPetals, true, m)[0] as PetalItem[];
    first.push({ kind: 'more', key: 'more', to: 1 });
    pages = [first, ...layout(formats.slice(take), 1, 0, maxPetals, false, m)];
  }

  // Cada grupo abre su propia página (o páginas), al final, con «Volver» a la página de su pétalo.
  for (const [group, list] of members) {
    const from = pages.findIndex((p) => p.some((item) => item.kind === 'group' && item.group === group));
    const start = pages.length;
    const groupPages = layout(
      list.map((target) => ({ kind: 'target', target })),
      start,
      from,
      maxPetals,
      false,
      m,
    );
    const petal = pages[from]?.find((item) => item.kind === 'group' && item.group === group);
    if (petal && petal.kind === 'group') {
      petal.to = start;
      // La esfera central resume lo que hay dentro: «Reducir, separar…».
      const names = list.map((t) => t.label.toLowerCase());
      const summary = names.slice(0, 2).join(', ') + (names.length > 2 ? '…' : '');
      petal.info.description = summary.charAt(0).toUpperCase() + summary.slice(1);
    }
    pages.push(...groupPages);
  }
  return pages;
}
