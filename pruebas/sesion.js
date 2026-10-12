// Pruebas de la sesión obligatoria en /facturar.
//
// Uso: npm install && npm test
//
// Levanta una base de mentira (auth, ops.usuarios y las dos escrituras del
// registro fiscal), el servicio con un ARCA de mentira (pruebas/arca-falso.js:
// no sale nada a ARCA) y prueba cada caso: sin EXIGIR_SESION, con
// EXIGIR_SESION=si y con ORIGENES_PERMITIDOS. Sale con código 1 si algo falla.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PUERTO_BASE = 54329;
const PUERTO_SERVICIO = 3999;
const AQUI = __dirname;

// ── La base falsa ──
const USUARIOS_AUTH = {
  'tok-activo': { id: 'u-activo', email: 'activo@lavadero.test' },
  'tok-baja': { id: 'u-baja', email: 'baja@lavadero.test' },
  'tok-null': { id: 'u-null', email: 'sinmarca@lavadero.test' },
  'tok-ajeno': { id: 'u-ajeno', email: 'cliente@tienda.test' },
};
const FILAS_OPS = {
  'u-activo': [{ id: 'u-activo', activo: true }],
  'u-baja': [{ id: 'u-baja', activo: false }],
  'u-null': [{ id: 'u-null', activo: null }],
  'u-ajeno': [],
};
let pedidosBase = [];
let base;
function levantarBase() {
  return new Promise((ok) => {
    base = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (c) => (cuerpo += c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        pedidosBase.push({ metodo: req.method, ruta: url.pathname, perfil: req.headers['accept-profile'] || req.headers['content-profile'] || null, apikey: req.headers.apikey, cuerpo });
        const json = (codigo, obj) => { res.writeHead(codigo, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
        if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
          const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const u = USUARIOS_AUTH[tok];
          return u ? json(200, { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated' })
                   : json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
        }
        if (req.method === 'GET' && url.pathname === '/rest/v1/usuarios') {
          if (req.headers['accept-profile'] !== 'ops') return json(406, { message: 'perfil equivocado' });
          const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
          return json(200, FILAS_OPS[id] || []);
        }
        if (req.method === 'POST' && url.pathname === '/rest/v1/facturas_emitidas') return json(201, []);
        if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/registrar_cae') return json(200, null);
        return json(404, { message: 'ruta falsa no prevista: ' + req.method + ' ' + url.pathname });
      });
    });
    base.listen(PUERTO_BASE, ok);
  });
}

// ── El servicio ──
let servicio, logServicio = '';
function levantarServicio(entorno) {
  logServicio = '';
  return new Promise((ok, mal) => {
    servicio = spawn(process.execPath, ['-r', path.join(AQUI, 'arca-falso.js'), path.join(AQUI, '..', 'server.js')], {
      cwd: path.join(AQUI, '..'),
      env: {
        PATH: process.env.PATH,
        PORT: String(PUERTO_SERVICIO),
        SUPABASE_URL: `http://127.0.0.1:${PUERTO_BASE}`,
        SUPABASE_SERVICE_KEY: 'clave-de-servicio-falsa',
        AFIP_CUIT: '20409378472',
        PUNTO_VENTA_GALPON: '3',
        ...entorno,
      },
    });
    servicio.stdout.on('data', (d) => { logServicio += d; if (/escuchando/.test(logServicio)) ok(); });
    servicio.stderr.on('data', (d) => { logServicio += d; });
    servicio.on('exit', (c) => mal(new Error('el servicio se cerró: ' + c + '\n' + logServicio)));
  });
}
function bajarServicio() {
  return new Promise((ok) => { servicio.removeAllListeners('exit'); servicio.on('exit', ok); servicio.kill(); });
}

function pedir(metodo, ruta, { token, cuerpo, encabezados } = {}) {
  return new Promise((ok, mal) => {
    const h = { ...(encabezados || {}) };
    if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: PUERTO_SERVICIO, method: metodo, path: ruta, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} ok({ estado: res.statusCode, enc: res.headers, json: j }); });
    });
    req.on('error', mal);
    if (cuerpo !== undefined) req.write(JSON.stringify(cuerpo));
    req.end();
  });
}

const FACTURA = { sucursal_id: 'galpon', tipo_comprobante: 'factura_b', total: 121000, venta_pos_id: 'venta-1', cliente: null };
const emisiones = () => (logServicio.match(/ARCA_EMITIO/g) || []).length;

let fallas = 0;
function chequear(nombre, condicion, detalle) {
  console.log((condicion ? '  ✓ ' : '  ✗ ') + nombre + (condicion ? '' : '  → ' + JSON.stringify(detalle)));
  if (!condicion) fallas++;
}

(async () => {
  await levantarBase();

  console.log('\n1 · Sin EXIGIR_SESION (lo que queda apenas se despliega)');
  await levantarServicio({});
  let r = await pedir('OPTIONS', '/facturar', { encabezados: { Origin: 'https://cyron.lavadero.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  chequear('la consulta previa del navegador acepta Authorization', r.estado === 204 && /authorization/i.test(r.enc['access-control-allow-headers'] || ''), r.enc);
  chequear('sin ORIGENES_PERMITIDOS responde a cualquier origen', r.enc['access-control-allow-origin'] === '*', r.enc);
  let antes = emisiones();
  r = await pedir('POST', '/facturar', { cuerpo: FACTURA });
  chequear('sin token todavía factura (no corta nada al desplegar)', r.estado === 200 && r.json && r.json.ok === true && emisiones() === antes + 1, r);
  chequear('y lo deja anotado en el log', /sin sesión válida/.test(logServicio), logServicio.slice(-300));
  r = await pedir('POST', '/facturar', { cuerpo: FACTURA, token: 'tok-activo' });
  chequear('con sesión válida factura y anota quién la pidió', r.json && r.json.ok === true && /pedida por activo@lavadero\.test/.test(logServicio), r);
  r = await pedir('GET', '/salud');
  chequear('/salud dice que la sesión todavía no se exige', r.json && /sin exigir/.test(r.json.sesion || ''), r.json);
  await bajarServicio();

  console.log('\n2 · Con EXIGIR_SESION=si');
  await levantarServicio({ EXIGIR_SESION: 'si' });
  const casos = [
    ['sin token', undefined, 401],
    ['token inventado', 'basura', 401],
    ['usuario dado de baja', 'tok-baja', 403],
    ['usuario que no es del equipo (un cliente de la tienda)', 'tok-ajeno', 403],
  ];
  for (const [nombre, token, codigo] of casos) {
    antes = emisiones();
    const escriturasAntes = pedidosBase.filter((p) => p.metodo === 'POST').length;
    r = await pedir('POST', '/facturar', { cuerpo: FACTURA, token });
    const escrituras = pedidosBase.filter((p) => p.metodo === 'POST').length - escriturasAntes;
    chequear(`${nombre}: ${codigo}, no llama a ARCA ni escribe en la base`, r.estado === codigo && r.json && r.json.ok === false && /^No se emitió/.test(r.json.error || '') && emisiones() === antes && escrituras === 0, { estado: r.estado, json: r.json, emisiones: emisiones() - antes, escrituras });
  }
  antes = emisiones();
  r = await pedir('POST', '/facturar', { cuerpo: FACTURA, token: 'tok-null' });
  chequear('activo vacío cuenta como activo (igual que ops.es_equipo)', r.estado === 200 && r.json && r.json.ok === true && emisiones() === antes + 1, r);
  pedidosBase = [];
  r = await pedir('POST', '/facturar', { cuerpo: { ...FACTURA, venta_pos_id: 'venta-2' }, token: 'tok-activo' });
  const guardo = pedidosBase.some((p) => p.ruta === '/rest/v1/facturas_emitidas' && p.metodo === 'POST');
  const anoto = pedidosBase.some((p) => p.ruta === '/rest/v1/rpc/registrar_cae' && /venta-2/.test(p.cuerpo));
  const consulto = pedidosBase.some((p) => p.ruta === '/rest/v1/usuarios' && p.perfil === 'ops');
  chequear('usuario activo: CAE, registro fiscal y CAE en la venta', r.estado === 200 && r.json && r.json.ok === true && !!r.json.cae && guardo && anoto, { r, guardo, anoto });
  chequear('el usuario se busca en ops.usuarios', consulto, pedidosBase.map((p) => p.ruta + ' ' + p.perfil));
  r = await pedir('GET', '/salud');
  chequear('/salud dice "exigida"', r.json && r.json.sesion === 'exigida', r.json);
  // La base se cae: no hay forma de confirmar al usuario.
  await new Promise((ok) => base.close(ok));
  antes = emisiones();
  r = await pedir('POST', '/facturar', { cuerpo: FACTURA, token: 'tok-activo' });
  chequear('si no se puede consultar la base, no emite (503)', r.estado === 503 && emisiones() === antes, { estado: r.estado, json: r.json });
  await bajarServicio();
  await levantarBase();

  console.log('\n3 · Con ORIGENES_PERMITIDOS');
  await levantarServicio({ EXIGIR_SESION: 'si', ORIGENES_PERMITIDOS: 'https://cyron.lavadero.test/, https://otro.test' });
  r = await pedir('OPTIONS', '/facturar', { encabezados: { Origin: 'https://cyron.lavadero.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  chequear('el origen permitido recibe su propio origen', r.enc['access-control-allow-origin'] === 'https://cyron.lavadero.test' && /Origin/.test(r.enc.vary || ''), r.enc);
  r = await pedir('OPTIONS', '/facturar', { encabezados: { Origin: 'https://ajeno.test', 'Access-Control-Request-Method': 'POST' } });
  chequear('otro origen no recibe permiso', !r.enc['access-control-allow-origin'], r.enc);
  r = await pedir('GET', '/salud');
  chequear('/salud lista los orígenes', r.json && Array.isArray(r.json.origenes) && r.json.origenes.length === 2, r.json);
  await bajarServicio();

  base.close();
  console.log(fallas ? `\n✗ ${fallas} prueba(s) fallaron` : '\n✓ Todo bien');
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
