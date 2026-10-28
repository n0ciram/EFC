/**
 * Imágenes a PDF con pdf-lib.
 *
 * - Los JPEG se incrustan tal cual (sin recomprimir) y la orientación EXIF se aplica girando la
 *   página, de modo que no hay pérdida de calidad.
 * - Los PNG se incrustan sin pérdidas, con su transparencia.
 * - El resto se convierte antes a PNG (sin pérdidas) o, si el original ya era con pérdidas y no
 *   tiene transparencia, a JPEG de alta calidad para no inflar el PDF.
 * - El tamaño de cada página corresponde al de la imagen según su resolución (96 ppp si no la declara).
 */
import { degrees, PDFDocument, type PDFImage } from 'pdf-lib';
import { ConversionError, toConversionError } from '../errors';
import { FORMATS } from '../formats';
import type { OpenedImage } from './image';

const DEFAULT_DPI = 96;

export async function createPdf(title: string): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('EFC — Easy File Converter');
  pdf.setProducer('EFC — Easy File Converter (pdf-lib)');
  pdf.setCreationDate(new Date());
  return pdf;
}

type Placement = 'normal' | 'rot90cw' | 'rot180' | 'rot90ccw';

const PASSTHROUGH_ORIENTATION: Record<number, Placement | undefined> = {
  1: 'normal',
  3: 'rot180',
  6: 'rot90cw',
  8: 'rot90ccw',
};

/** Añade una página con la imagen (o la página `page` de un TIFF multipágina). */
export async function addImagePage(pdf: PDFDocument, img: OpenedImage, page: number): Promise<void> {
  let embedded: PDFImage | null = null;
  let placement: Placement = 'normal';

  try {
    if (img.format === 'jpg' && !img.multiPage && img.space !== 'cmyk') {
      const p = PASSTHROUGH_ORIENTATION[img.orientation];
      if (p) {
        embedded = await pdf.embedJpg(img.buffer).catch(() => null);
        if (embedded) placement = p;
      }
    } else if (img.format === 'png' && img.orientation === 1 && !img.depth16) {
      embedded = await pdf.embedPng(img.buffer).catch(() => null);
    }

    if (!embedded) {
      const pipeline = img.pipeline({ page }).toColourspace('srgb');
      const preferJpeg = FORMATS[img.format].lossy && !img.hasAlpha;
      if (preferJpeg) {
        const jpg = await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
        embedded = await pdf.embedJpg(jpg);
      } else {
        const png = await pipeline.png({ compressionLevel: 6 }).toBuffer();
        embedded = await pdf.embedPng(png);
      }
      placement = 'normal';
    }
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  }

  // Dimensiones visibles (ya orientadas) en puntos PDF.
  const dpi = img.density ?? DEFAULT_DPI;
  const widthPt = (img.width * 72) / dpi;
  const heightPt = (img.height * 72) / dpi;
  if (!(widthPt > 0 && heightPt > 0)) throw new ConversionError('corrupt', 'Dimensiones no válidas');
  const pdfPage = pdf.addPage([widthPt, heightPt]);

  switch (placement) {
    case 'normal':
      pdfPage.drawImage(embedded, { x: 0, y: 0, width: widthPt, height: heightPt });
      break;
    case 'rot180':
      pdfPage.drawImage(embedded, { x: widthPt, y: heightPt, width: widthPt, height: heightPt, rotate: degrees(180) });
      break;
    case 'rot90cw':
      // La imagen almacenada es apaisada respecto a la visible: se dibuja girada 90° en sentido horario.
      pdfPage.drawImage(embedded, { x: 0, y: heightPt, width: heightPt, height: widthPt, rotate: degrees(-90) });
      break;
    case 'rot90ccw':
      pdfPage.drawImage(embedded, { x: widthPt, y: 0, width: heightPt, height: widthPt, rotate: degrees(90) });
      break;
  }
}

export async function savePdf(pdf: PDFDocument): Promise<Buffer> {
  const bytes = await pdf.save({ useObjectStreams: true });
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Verifica que el PDF generado se puede leer y tiene el número de páginas esperado. */
export async function verifyPdf(data: Uint8Array, expectedPages: number): Promise<void> {
  try {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    if (doc.getPageCount() !== expectedPages) {
      throw new ConversionError('verify_failed', `Páginas: ${doc.getPageCount()} de ${expectedPages}`);
    }
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError('verify_failed', (err as Error).message);
  }
}
