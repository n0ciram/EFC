import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableTargets, explainNoTargets, type EngineCaps, type FfmpegCaps } from '../../electron/conversion/registry';

const fullFfmpeg: FfmpegCaps = {
  path: 'ffmpeg',
  version: 'test',
  source: 'path',
  encoders: new Set(['libx264', 'aac', 'libmp3lame', 'libvorbis', 'libopus', 'flac', 'pcm_s16le', 'libvpx-vp9', 'gif']),
};
const caps = (ffmpeg: FfmpegCaps | null = fullFfmpeg): EngineCaps => ({ image: true, pdf: true, ffmpeg });
const ids = (list: { id: string }[]): string[] => list.map((t) => t.id);

describe('Registro de conversiones', () => {
  it('ofrece para PNG solo destinos reales y empieza por el más relevante', () => {
    const targets = availableTargets([{ format: 'png' }], caps());
    assert.deepEqual(ids(targets), ['jpg', 'webp', 'pdf', 'shrink', 'ico', 'avif', 'tiff', 'bmp', 'gif']);
    assert.ok(!ids(targets).includes('png'), 'no debe ofrecer el mismo formato');
  });

  it('ofrece para PDF páginas a imagen, texto y las herramientas de PDF', () => {
    assert.deepEqual(ids(availableTargets([{ format: 'pdf' }], caps())), ['jpg', 'shrink', 'pdf-split', 'pdf-rotate', 'png', 'txt', 'webp', 'tiff']);
    const pdf = availableTargets([{ format: 'pdf' }], caps());
    assert.deepEqual(pdf.slice(1, 4).map((t) => t.label), ['REDUCIR', 'SEPARAR', 'GIRAR']);
    // Las herramientas van agrupadas en «Herramientas PDF»; los formatos, no.
    assert.deepEqual(pdf.filter((t) => t.group === 'pdf-tools').map((t) => t.id), ['shrink', 'pdf-split', 'pdf-rotate']);
    assert.ok(pdf.filter((t) => !t.group).every((t) => ['jpg', 'png', 'txt', 'webp', 'tiff'].includes(t.id)));
    // Con imágenes, las herramientas van en «Herramientas»; los formatos, en la rueda principal.
    const jpg = availableTargets([{ format: 'jpg' }], caps());
    assert.deepEqual(jpg.filter((t) => t.group === 'image-tools').map((t) => t.id), ['shrink']);
    assert.ok(jpg.filter((t) => !t.group).every((t) => t.id !== 'shrink'));
    // En vídeo, REDUCIR sigue en la rueda principal.
    assert.ok(availableTargets([{ format: 'mp4' }], caps()).every((t) => !t.group));
    // Sin sharp no se puede reducir un PDF, pero sí separar y girar (solo usan pdf-lib).
    const noImage = ids(availableTargets([{ format: 'pdf' }], { ...caps(), image: false }));
    assert.ok(!noImage.includes('shrink') && noImage.includes('pdf-split') && noImage.includes('pdf-rotate'));
  });

  it('con varios PDF, o PDF e imágenes, «UNIR» va el primero', () => {
    const many = availableTargets([{ format: 'pdf' }, { format: 'pdf' }], caps());
    assert.equal(many[0]?.id, 'pdf-merge');
    assert.equal(many[0]?.group, 'pdf-tools');
    // Imágenes solas: UNIR y REDUCIR van en «Herramientas».
    const images = availableTargets([{ format: 'jpg' }, { format: 'png' }], caps());
    assert.deepEqual(images.filter((t) => t.group === 'image-tools').map((t) => t.id).sort(), ['pdf-merge', 'shrink']);
    const mixed = ids(availableTargets([{ format: 'jpg' }, { format: 'pdf' }], caps()));
    assert.equal(mixed[0], 'pdf-merge');
    assert.ok(!mixed.includes('pdf-split'), 'SEPARAR solo tiene sentido si todos son PDF');
  });

  it('ofrece «Reducir» para fotos, vídeos y PDF (el primero en un MP4), pero no para SVG', () => {
    assert.equal(ids(availableTargets([{ format: 'jpg' }], caps()))[1], 'shrink');
    assert.equal(ids(availableTargets([{ format: 'mp4' }], caps()))[0], 'shrink');
    assert.ok(!ids(availableTargets([{ format: 'svg' }], caps())).includes('shrink'));
    assert.ok(ids(availableTargets([{ format: 'pdf' }], caps())).includes('shrink'));
    // Fotos y vídeos a la vez: cada uno se reduce con su motor.
    assert.ok(ids(availableTargets([{ format: 'jpg' }, { format: 'mov' }], caps())).includes('shrink'));
    // Sin FFmpeg, los vídeos no se pueden reducir.
    assert.ok(!ids(availableTargets([{ format: 'mp4' }], caps(null))).includes('shrink'));
    const shrink = availableTargets([{ format: 'jpg' }], caps()).find((t) => t.id === 'shrink');
    assert.deepEqual([shrink?.label, shrink?.icon], ['REDUCIR', 'shrink']);
  });

  it('ofrece para texto PDF y Word, y PDF solo si está la fuente incluida', () => {
    assert.deepEqual(ids(availableTargets([{ format: 'txt' }], caps())), ['pdf', 'docx']);
    assert.deepEqual(ids(availableTargets([{ format: 'txt' }], { ...caps(), text: false })), ['docx']);
  });

  it('no ofrece audio ni vídeo si FFmpeg no está disponible', () => {
    assert.deepEqual(availableTargets([{ format: 'mp4' }], caps(null)), []);
    assert.match(explainNoTargets([{ format: 'mp4' }], caps(null)), /FFmpeg no está disponible/);
    // Un GIF sigue ofreciendo destinos de imagen, pero no MP4/WEBM.
    const gif = ids(availableTargets([{ format: 'gif' }], caps(null)));
    assert.ok(gif.includes('png'));
    assert.ok(!gif.includes('mp4'));
  });

  it('respeta los codificadores presentes en la compilación de FFmpeg', () => {
    const noX264: FfmpegCaps = { ...fullFfmpeg, encoders: new Set(['aac', 'libmp3lame', 'pcm_s16le', 'flac']) };
    const targets = ids(availableTargets([{ format: 'mov' }], caps(noX264)));
    assert.ok(!targets.includes('mp4'), 'sin H.264 no se ofrece MP4');
    assert.ok(targets.includes('mp3'), 'el audio sí se puede extraer');
  });

  it('ofrece para vídeo el contenedor principal y la extracción de audio', () => {
    assert.deepEqual(ids(availableTargets([{ format: 'mov' }], caps())), ['mp4', 'shrink', 'mp3', 'gif', 'webm', 'mkv', 'm4a', 'wav']);
  });

  it('con varias imágenes añade «Unir en PDF» junto a PDF y permite el formato de alguna de ellas', () => {
    const targets = ids(availableTargets([{ format: 'png' }, { format: 'jpg' }], caps()));
    assert.equal(targets[targets.indexOf('pdf') + 1], 'pdf-merge');
    assert.ok(targets.includes('jpg'), 'JPG se ofrece: el PNG se convierte y el JPG se omite');
  });

  it('con selecciones mixtas solo ofrece destinos comunes', () => {
    // PNG + PDF: imagen ↔ imagen y PDF → imagen; «PDF» y «PNG» se ofrecen omitiendo el archivo que ya lo es.
    const targets = ids(availableTargets([{ format: 'png' }, { format: 'pdf' }], caps()));
    assert.deepEqual(targets.sort(), ['jpg', 'pdf', 'pdf-merge', 'png', 'shrink', 'tiff', 'webp'].sort());
    assert.deepEqual(availableTargets([{ format: 'mp3' }, { format: 'pdf' }], caps()), []);
  });

  it('no ofrece nada para HEIC y explica el motivo', () => {
    assert.deepEqual(availableTargets([{ format: 'heic' }], caps()), []);
    assert.match(explainNoTargets([{ format: 'heic' }], caps()), /HEIC/);
  });

  it('Office → PDF solo con la aplicación instalada que abre cada documento', () => {
    const office = (word: boolean, excel: boolean, powerpoint: boolean): EngineCaps => ({ ...caps(), office: { word, excel, powerpoint } });
    for (const format of ['docx', 'doc', 'rtf', 'odt', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp'] as const) {
      const targets = availableTargets([{ format }], office(true, true, true));
      assert.deepEqual(ids(targets), ['pdf'], format);
      assert.equal(targets[0]?.engine, 'office-pdf');
      assert.equal(targets[0]?.group, undefined, 'PDF es un formato: va en la rueda principal');
      assert.deepEqual(ids(availableTargets([{ format }], caps())), [], `${format} sin Office`);
    }
    // Solo Word: los Excel no se ofrecen y el aviso dice qué falta.
    assert.deepEqual(ids(availableTargets([{ format: 'xlsx' }], office(true, false, false))), []);
    assert.equal(explainNoTargets([{ format: 'xlsx' }], office(true, false, false)), 'Para convertir XLSX a PDF hace falta tener Microsoft Excel instalado.');
    assert.equal(
      explainNoTargets([{ format: 'docx' }, { format: 'pptx' }], caps()),
      'Para convertir DOCX, PPTX a PDF hace falta tener Microsoft Word y Microsoft PowerPoint instalados.',
    );
  });

  it('Office mezclado con otros archivos: PDF si todos pueden, pero sin UNIR', () => {
    const all: EngineCaps = { ...caps(), office: { word: true, excel: true, powerpoint: true } };
    assert.deepEqual(ids(availableTargets([{ format: 'docx' }, { format: 'xlsx' }, { format: 'pptx' }], all)), ['pdf']);
    assert.deepEqual(ids(availableTargets([{ format: 'docx' }, { format: 'jpg' }], all)), ['pdf']);
    assert.deepEqual(ids(availableTargets([{ format: 'docx' }, { format: 'txt' }], all)), ['pdf', 'docx']);
    // El PDF ya lo es: se omite y se convierte solo el Word.
    assert.deepEqual(ids(availableTargets([{ format: 'docx' }, { format: 'pdf' }], all)), ['pdf']);
  });
});
