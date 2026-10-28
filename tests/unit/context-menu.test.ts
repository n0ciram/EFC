import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OpenBatcher, OpenRequestServer, openPipePath, parseOpenMessage } from '../../electron/main/open-requests';
import { allMenuExtensions, extensionsFromMarker, MENU_VERB, menuExtensions, registrationMarker, registryScript } from '../../electron/windows/context-menu';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Menú contextual: registro', () => {
  it('aparece solo en las extensiones que EFC sabe convertir', () => {
    const exts = menuExtensions(null);
    for (const e of ['png', 'jpg', 'jpeg', 'pdf', 'txt', 'csv', 'mp4', 'mov', 'wav', 'svg']) assert.ok(exts.includes(e), e);
    for (const e of ['ico', 'heic', 'docx', 'xlsx', 'pptx', 'exe', 'zip']) assert.ok(!exts.includes(e), e);
  });

  it('los documentos de Office, solo si su aplicación está instalada', () => {
    const word = menuExtensions({ word: true, excel: false, powerpoint: false });
    for (const e of ['docx', 'doc', 'rtf', 'odt']) assert.ok(word.includes(e), e);
    for (const e of ['xlsx', 'xls', 'ods', 'pptx', 'ppsx', 'ppt', 'pps', 'odp']) assert.ok(!word.includes(e), e);
    const all = allMenuExtensions();
    for (const e of ['docx', 'xlsx', 'ods', 'pptx', 'ppsx', 'pps', 'odp']) assert.ok(all.includes(e), e);
    assert.equal(all.length, menuExtensions(null).length + 12);
  });

  it('el .reg borra primero, registra por usuario y escapa bien la orden', () => {
    const helperExe = 'C:\\Users\\Ana Pérez\\AppData\\Local\\Programs\\efc\\resources\\helper\\efc-helper.exe';
    const script = registryScript({ register: true, helperExe, iconExe: 'C:\\x\\EFC.exe', extensions: menuExtensions(null), text: 'Convertir con EFC', previous: ['xyz'] });
    const lines = script.split('\r\n');
    assert.equal(lines[0], 'Windows Registry Editor Version 5.00');
    const firstAdd = lines.findIndex((l) => l.startsWith('[HKEY'));
    const lastDelete = lines.map((l, i) => (l.startsWith('[-HKEY') ? i : -1)).reduce((a, b) => Math.max(a, b));
    assert.ok(lastDelete < firstAdd, 'los borrados van antes que las altas');
    assert.ok(script.includes(`[-HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.xyz\\shell\\${MENU_VERB}]`), 'borra extensiones antiguas');
    assert.ok(script.includes(`[HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.png\\shell\\${MENU_VERB}\\command]`));
    assert.ok(script.includes('@="\\"C:\\\\Users\\\\Ana Pérez\\\\AppData\\\\Local\\\\Programs\\\\efc\\\\resources\\\\helper\\\\efc-helper.exe\\" --open \\"%1\\""'));
    assert.ok(script.includes('"MultiSelectModel"="Player"'));
    assert.ok(script.includes('@="Convertir con EFC"'));
    assert.ok(!script.includes('HKEY_LOCAL_MACHINE'), 'nunca toca el registro del equipo');
    const english = registryScript({ register: true, helperExe, iconExe: 'C:\\x\\EFC.exe', extensions: ['png'], text: 'Convert with EFC' });
    assert.ok(english.includes('"MUIVerb"="Convert with EFC"'));
  });

  it('al desactivarlo solo borra', () => {
    const script = registryScript({ register: false, helperExe: 'C:\\h.exe', iconExe: 'C:\\e.exe', extensions: allMenuExtensions(), text: 'Convertir con EFC' });
    assert.ok(!script.split('\r\n').some((l) => l.startsWith('[HKEY')));
    assert.ok(script.includes('[-HKEY_CURRENT_USER'));
  });

  it('la marca recuerda las extensiones registradas', () => {
    const extensions = menuExtensions({ word: true, excel: true, powerpoint: false });
    const marker = registrationMarker('1.4.0', 'C:\\H.exe', extensions, 'es');
    assert.deepEqual(extensionsFromMarker(marker), extensions);
    assert.notEqual(marker, registrationMarker('1.4.0', 'C:\\H.exe', allMenuExtensions(), 'es'), 'si se instala PowerPoint, se vuelve a registrar');
    assert.notEqual(marker, registrationMarker('1.4.0', 'C:\\H.exe', extensions, 'en'), 'si cambia el idioma, se vuelve a registrar');
    assert.deepEqual(extensionsFromMarker(''), []);
  });

  it('el desinstalador borra exactamente las mismas claves (sin tocarlas al actualizar)', () => {
    const nsh = readFileSync(path.join(__dirname, '..', '..', 'resources', 'build', 'installer.nsh'), 'utf8');
    const keys = [...nsh.matchAll(/DeleteRegKey HKCU "Software\\Classes\\SystemFileAssociations\\\.([a-z0-9]+)\\shell\\EFC\.Convert"/g)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), allMenuExtensions());
    assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}/);
  });
});

describe('Menú contextual: peticiones', () => {
  it('acepta solo mensajes bien formados con rutas razonables', () => {
    assert.deepEqual(parseOpenMessage('{"v":1,"paths":["C:\\\\a\\\\foto ñ.jpg"],"x":1,"y":2}'), ['C:\\a\\foto ñ.jpg']);
    assert.deepEqual(parseOpenMessage('{"v":2,"paths":["C:\\\\a.jpg"]}'), []);
    assert.deepEqual(parseOpenMessage('no es json'), []);
    assert.deepEqual(parseOpenMessage('{"v":1,"paths":[1,null,"","C:\\\\b.png","x\\u0000y"]}'), ['C:\\b.png']);
    assert.equal(parseOpenMessage(JSON.stringify({ v: 1, paths: Array.from({ length: 900 }, (_, i) => `C:\\f${i}.png`) })).length, 500);
  });

  it('reúne los archivos que llegan seguidos en una sola entrega, sin duplicados', async () => {
    const batches: string[][] = [];
    const batcher = new OpenBatcher((p) => batches.push(p), 60, 1000);
    batcher.add(['C:\\a.jpg']);
    await sleep(20);
    batcher.add(['C:\\b.jpg', 'c:\\A.JPG']);
    await sleep(20);
    batcher.add(['C:\\c.jpg']);
    await sleep(150);
    batcher.add(['C:\\d.jpg']);
    await sleep(150);
    assert.deepEqual(batches, [['C:\\a.jpg', 'C:\\b.jpg', 'C:\\c.jpg'], ['C:\\d.jpg']]);
  });

  it('el nombre de la tubería es por usuario', () => {
    assert.equal(openPipePath('Ana'), '\\\\.\\pipe\\efc-open-Ana');
  });

  it('servidor real: varios lanzadores a la vez → una sola petición con todas las rutas', async () => {
    const socket = process.platform === 'win32' ? openPipePath(`prueba-${process.pid}`) : path.join(os.tmpdir(), `efc-open-${process.pid}.sock`);
    const received: string[][] = [];
    const server = new OpenRequestServer((p) => received.push(p));
    assert.equal(await server.start(socket), true);
    try {
      const send = (p: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const c = net.connect(socket, () => c.end(`${JSON.stringify({ v: 1, paths: [p], x: 0, y: 0 })}\n`));
          c.on('close', () => resolve());
          c.on('error', reject);
        });
      await Promise.all(['C:\\x\\uno.png', 'C:\\x\\dos.png', 'C:\\x\\tres ñ.png'].map(send));
      await sleep(600);
      assert.equal(received.length, 1);
      assert.deepEqual([...(received[0] ?? [])].sort(), ['C:\\x\\dos.png', 'C:\\x\\tres ñ.png', 'C:\\x\\uno.png']);
    } finally {
      server.stop();
    }
  });
});
