// ARCA de mentira para las pruebas: reemplaza @afipsdk/afip.js antes de que
// server.js lo cargue, así ninguna prueba emite un comprobante de verdad. Anota cada comprobante pedido en el log, así la
// prueba sabe si se llegó a llamar a ARCA o no.
const Module = require('module');
const cargar = Module._load;
let numero = 100;
Module._load = function (pedido, padre, esPrincipal) {
  if (pedido === '@afipsdk/afip.js') {
    return class AfipFalso {
      constructor(opciones) {
        this.options = { ...opciones, production: false };
        this.ElectronicBilling = {
          createNextVoucher: async (datos) => {
            numero += 1;
            console.log('ARCA_EMITIO ' + JSON.stringify({ PtoVta: datos.PtoVta, CbteTipo: datos.CbteTipo, ImpTotal: datos.ImpTotal }));
            return { CAE: '761234567890' + numero, CAEFchVto: '2026-10-22', voucherNumber: numero };
          },
          getServerStatus: async () => ({ AppServer: 'OK', DbServer: 'OK', AuthServer: 'OK' }),
        };
      }
    };
  }
  return cargar.apply(this, arguments);
};
