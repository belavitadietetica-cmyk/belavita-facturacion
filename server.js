const http = require('http');
const Afip = require('@afipsdk/afip.js');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Configuración de AFIP SDK ──
// Todas estas variables se cargan desde Railway (Settings → Variables), nunca
// hardcodeadas acá. AFIP_PRODUCTION debe quedar en "false" hasta que probemos
// bien en homologación y estemos seguros de pasar a facturas reales.
//
// Mientras esperamos el certificado propio de Belavita, se puede probar todo
// el flujo con el CUIT de pruebas que da AfipSDK sin necesitar certificado
// (AFIP_CUIT=20409378472, sin AFIP_CERT ni AFIP_KEY). Cuando llegue el
// certificado real, se agregan AFIP_CERT/AFIP_KEY y se cambia AFIP_CUIT al
// de Belavita — no hace falta tocar una sola línea de código para el cambio.
const afip = new Afip({
  CUIT: parseInt(process.env.AFIP_CUIT, 10),
  access_token: process.env.AFIP_ACCESS_TOKEN,
  production: process.env.AFIP_PRODUCTION === 'true',
  ...(process.env.AFIP_CERT ? { cert: process.env.AFIP_CERT } : {}),
  ...(process.env.AFIP_KEY ? { key: process.env.AFIP_KEY } : {}),
});

const TASA_IVA = 0.21;
const IVA_ID_21 = 5; // código AFIP para alícuota 21%

// Tipos de comprobante AFIP (códigos fijos y estándar, no cambian)
//   1  = Factura A  · emisor Responsable Inscripto, receptor RI
//   6  = Factura B  · emisor Responsable Inscripto, receptor CF
//   11 = Factura C  · emisor MONOTRIBUTISTA. No discrimina IVA.
const CBTE_TIPO = { factura_a: 1, factura_b: 6, factura_c: 11 };

// Un punto de venta habilitado en ARCA por sucursal, cargado por variable
// de entorno: PUNTO_VENTA_BV1, PUNTO_VENTA_BV2, PUNTO_VENTA_LOCAL, etc.
//
// Se resuelve al vuelo y no con una lista fija: antes estaban escritas las
// tres sucursales de Belavita, así que un cliente con otro sucursal_id
// nunca encontraba su punto de venta aunque la variable estuviera cargada.
function claveDePuntoVenta(sucursalId) {
  return 'PUNTO_VENTA_' + String(sucursalId || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function puntoVentaDe(sucursalId) {
  if (!sucursalId) return null;
  const valor = process.env[claveDePuntoVenta(sucursalId)];
  if (!valor) return null;
  const n = parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Cola simple: procesa una factura a la vez, para que dos ventas casi
// simultáneas nunca pidan el mismo número de comprobante a ARCA
let colaFacturacion = Promise.resolve();
function encolar(tarea) {
  const resultado = colaFacturacion.then(tarea, tarea);
  colaFacturacion = resultado.catch(() => {}); // no cortar la cola si una factura falla
  return resultado;
}

function hoyYYYYMMDD() {
  const d = new Date();
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().split('T')[0].replace(/-/g, '');
}

// ── Escrituras en Supabase, con reintento ──────────────────────────────
//
// Por qué existe esto: supabase-js NO tira excepción cuando una escritura
// falla — devuelve { error } y sigue de largo. La versión anterior de este
// archivo no miraba ese error, así que si el guardado se rechazaba (por
// permisos, por red, por lo que fuera) el servicio respondía ok igual y el
// registro fiscal simplemente no quedaba. Eso fue exactamente lo que pasó
// en julio: 235 facturas emitidas y solo 72 registradas.
//
// El reintento es seguro porque las dos escrituras son idempotentes: el
// guardado del comprobante va por upsert contra la clave única
// (punto_venta, tipo_comprobante, numero), y el merge del CAE en la venta
// escribe siempre los mismos valores.
async function conReintento(operacion, intentos = 3) {
  let ultimoError = null;
  for (let i = 1; i <= intentos; i++) {
    try {
      const { error } = await operacion();
      if (!error) return { ok: true };
      ultimoError = error;
    } catch (e) {
      ultimoError = e;
    }
    if (i < intentos) await new Promise(r => setTimeout(r, 400 * i));
  }
  return { ok: false, error: ultimoError };
}

// Deja el dato fiscal dentro de la venta del POS. Va por la función
// ops.registrar_cae porque hace el merge del JSONB del lado del servidor:
// escribir datos_extra entero desde acá pisaría pago_dividido.
//
// Antes esto lo hacía el navegador, que es el peor lugar posible para
// guardar un dato fiscal — se puede cerrar la ventana, caer el wifi o
// vencer la sesión justo en ese momento y el CAE se perdía.
async function anotarEnVenta(ventaPosId, patch) {
  if (!ventaPosId) return { ok: true, omitido: true }; // factura cargada a mano, sin venta asociada
  return conReintento(() =>
    sb.schema('ops').rpc('registrar_cae', { p_venta_id: ventaPosId, p_patch: patch })
  );
}

// Arma y emite un comprobante — separado de la parte HTTP para poder
// testearlo o reusarlo fácil
async function emitirComprobante({ sucursal_id, punto_venta, tipo_comprobante, total, cliente }) {
  const puntoVenta = punto_venta || puntoVentaDe(sucursal_id);
  // El mensaje dice EXACTAMENTE la variable que hay que crear: si dijera
  // otra —por ejemplo con un guion donde va un guion bajo— quien la copie
  // cargaría una que el código nunca va a leer.
  if (!puntoVenta) throw new Error(`No hay punto de venta configurado para "${sucursal_id}". Definí ${claveDePuntoVenta(sucursal_id)} en Railway.`);

  const cbteTipo = CBTE_TIPO[tipo_comprobante];
  if (!cbteTipo) throw new Error(`tipo_comprobante inválido: "${tipo_comprobante}" (esperaba factura_a, factura_b o factura_c)`);

  const esFacturaA = tipo_comprobante === 'factura_a';
  const esFacturaC = tipo_comprobante === 'factura_c';

  // ── Los importes ────────────────────────────────────────────────────
  // FACTURA A y B: el emisor es Responsable Inscripto y SÍ discrimina IVA.
  // El total del mostrador ya lo lleva adentro, así que se separa.
  //
  // FACTURA C: el emisor es monotributista y NO discrimina IVA. Según las
  // especificaciones del WSFEv1:
  //   · ImpNeto  = el subtotal, o sea el total (ImpTotal = ImpNeto + ImpTrib)
  //   · ImpIVA   = 0
  //   · ImpOpEx  = 0
  //   · el array Iva NO se informa  → error 10071 si se manda igual
  //
  // Dividir el total por 1,21 en una Factura C sería declarar un importe
  // menor al que se cobró.
  const neto = esFacturaC ? total : Math.round((total / (1 + TASA_IVA)) * 100) / 100;
  const iva  = esFacturaC ? 0     : Math.round((total - neto) * 100) / 100;

  const data = {
    PtoVta: puntoVenta,
    CbteTipo: cbteTipo,
    Concepto: 1, // Productos
    DocTipo: esFacturaA ? 80 : 99, // 80 = CUIT, 99 = Consumidor Final
    DocNro: esFacturaA ? parseInt(cliente?.cuit, 10) : 0,
    ImpTotal: total,
    ImpTotConc: 0,
    ImpNeto: neto,
    ImpOpEx: 0,
    ImpIVA: iva,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
    CbteFch: parseInt(hoyYYYYMMDD(), 10),
    // El array de alícuotas solo va en A y B. En C su sola presencia hace
    // que ARCA rechace el comprobante con el error 10071.
    ...(esFacturaC ? {} : { Iva: [{ Id: IVA_ID_21, BaseImp: neto, Importe: iva }] }),
    // Campo obligatorio desde RG 5616 — 1: Responsable Inscripto, 5: Consumidor Final
    CondicionIVAReceptorId: esFacturaA ? 1 : 5,
  };

  const res = await afip.ElectronicBilling.createNextVoucher(data);

  return {
    cae: res.CAE,
    cae_vencimiento: res.CAEFchVto,
    numero: res.voucherNumber,
    punto_venta: puntoVenta,
    tipo_comprobante,
    importe_total: total,
    importe_neto: neto,
    importe_iva: iva,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Chequeo de salud + estado de los servidores de ARCA ──
  if (req.method === 'GET' && req.url === '/salud') {
    try {
      const estadoArca = await afip.ElectronicBilling.getServerStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ambiente: afip.options.production ? 'PRODUCCIÓN' : 'homologación', arca: estadoArca }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Emitir un comprobante ──
  if (req.method === 'POST' && req.url === '/facturar') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'JSON inválido' })); return; }

      try {
        const resultado = await encolar(() => emitirComprobante(payload));

        // ── A partir de acá la factura YA EXISTE en ARCA ──
        // Todo lo que siga puede fallar, pero nunca debe hacernos responder
        // que la factura no salió: si el POS creyera que falló, la volvería
        // a emitir y tendríamos un comprobante duplicado ante ARCA. Los
        // problemas de guardado viajan en "aviso", no en "ok".
        const avisos = [];

        // 1. Registro fiscal propio. Upsert contra la clave única del
        //    comprobante, así un reintento nunca duplica la fila.
        const guardado = await conReintento(() =>
          sb.schema('ops').from('facturas_emitidas').upsert({
            sucursal_id: payload.sucursal_id,
            venta_pos_id: payload.venta_pos_id || null,
            punto_venta: resultado.punto_venta,
            tipo_comprobante: resultado.tipo_comprobante,
            numero: resultado.numero,
            cae: resultado.cae,
            cae_vencimiento: resultado.cae_vencimiento,
            importe_total: resultado.importe_total,
            importe_neto: resultado.importe_neto,
            importe_iva: resultado.importe_iva,
            cliente_cuit: payload.cliente?.cuit || null,
            cliente_razon_social: payload.cliente?.razon_social || null,
          }, { onConflict: 'punto_venta,tipo_comprobante,numero' })
        );
        if (!guardado.ok) {
          console.error('❌ No se pudo guardar en facturas_emitidas:', guardado.error?.message || guardado.error);
          avisos.push('el comprobante salió pero no se pudo guardar en el registro fiscal');
        }

        // 2. El dato fiscal dentro de la venta, para el ticket y las
        //    pantallas. Mismos nombres de campo que usaba el frontend.
        const anotado = await anotarEnVenta(payload.venta_pos_id, {
          cae: resultado.cae,
          cae_vencimiento: resultado.cae_vencimiento,
          numero_comprobante: resultado.numero,
          punto_venta: resultado.punto_venta,
          importe_iva: resultado.importe_iva,
          importe_neto: resultado.importe_neto,
          tipo_comprobante_detalle: resultado.tipo_comprobante,
          cliente_cuit: payload.cliente?.cuit || null,
          cliente_direccion: payload.cliente?.direccion || null,
        });
        if (!anotado.ok) {
          console.error('❌ No se pudo anotar el CAE en la venta:', anotado.error?.message || anotado.error);
          avisos.push('el comprobante salió pero no quedó anotado en la venta');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...resultado, ...(avisos.length ? { aviso: avisos.join(' · ') } : {}) }));
      } catch (e) {
        console.error('❌ Error al facturar:', e.message, e.data || '');

        // La factura no salió. Antes esto moría en un mensaje que el
        // vendedor veía una vez y desaparecía; ahora queda anotado en la
        // venta, así la pantalla de revisión puede mostrarlo después.
        try {
          await anotarEnVenta(payload.venta_pos_id, {
            factura_error: String(e.message || 'error desconocido').slice(0, 300),
            factura_error_at: new Date().toISOString(),
          });
        } catch (e2) {
          console.error('❌ Tampoco se pudo anotar el error en la venta:', e2.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message, detalle: e.data || null }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Ruta no encontrada. Usá POST /facturar o GET /salud' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧾 Belavita Facturación escuchando en el puerto ${PORT}`);
  console.log(`📍 Ambiente: ${afip.options.production ? 'PRODUCCIÓN (facturas reales)' : 'HOMOLOGACIÓN (pruebas, no válidas fiscalmente)'}`);
});
