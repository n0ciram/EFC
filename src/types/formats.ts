/**
 * Tipos compartidos entre el proceso principal, el proceso de conversión y la interfaz.
 * Este archivo solo contiene tipos: no importa nada de Node ni del DOM.
 */

export type FormatCategory = 'image' | 'document' | 'audio' | 'video';

export type FormatId =
  // Imágenes
  | 'png'
  | 'jpg'
  | 'webp'
  | 'avif'
  | 'bmp'
  | 'tiff'
  | 'gif'
  | 'ico'
  | 'svg'
  | 'heic'
  // Documentos
  | 'pdf'
  | 'txt'
  | 'docx'
  // Office y OpenDocument (solo como origen, con Office instalado)
  | 'doc'
  | 'rtf'
  | 'odt'
  | 'xlsx'
  | 'xls'
  | 'ods'
  | 'pptx'
  | 'ppt'
  | 'odp'
  // Audio
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'ogg'
  | 'opus'
  | 'm4a'
  | 'aac'
  | 'wma'
  | 'aiff'
  | 'amr'
  // Vídeo
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'mkv'
  | 'avi'
  | 'wmv'
  | 'flv'
  | 'mpeg'
  | 'ts'
  | '3gp';

/**
 * Identificador de destino que aparece en la rueda. `pdf-merge` une varias imágenes en un PDF y
 * `shrink` reduce el tamaño de imágenes, vídeos y PDF para enviarlos; `pdf-split` separa las páginas
 * de un PDF y `pdf-rotate` las gira 90°.
 */
export type TargetId = FormatId | 'pdf-merge' | 'shrink' | 'pdf-split' | 'pdf-rotate';

/** Iconos disponibles en la interfaz (todos se dibujan con SVG propio). */
export type IconId =
  | 'photo'
  | 'photo-alpha'
  | 'web'
  | 'sparkle'
  | 'grid'
  | 'layers'
  | 'frames'
  | 'app'
  | 'vector'
  | 'document'
  | 'text'
  | 'note'
  | 'wave'
  | 'wave-lossless'
  | 'waves'
  | 'film'
  | 'play'
  | 'merge'
  | 'shrink'
  | 'split'
  | 'rotate'
  | 'toolbox'
  | 'more'
  | 'back'
  | 'check'
  | 'alert'
  | 'close'
  | 'info';
