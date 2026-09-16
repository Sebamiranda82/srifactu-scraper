'use strict';
const express    = require('express');
const cors       = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app  = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// Keep-alive
setInterval(() => {
  require('https').get('https://srifactu-scraper.up.railway.app/health', ()=>{}).on('error',()=>{});
}, 10*60*1000);

app.get('/health', (req, res) => {
  res.json({ ok: true, servicio: 'srifactu-scraper' });
});

// POST /facturas-sri
// Body: { ruc, clave, fechaDesde, fechaHasta }
// fechaDesde / fechaHasta: "dd/mm/yyyy"
app.post('/facturas-sri', async (req, res) => {
  const { ruc, clave, fechaDesde, fechaHasta } = req.body;
  if (!ruc || !clave || !fechaDesde || !fechaHasta) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Login SRI (con reintentos por posibles bloqueos/cortes de red)
    console.log('Entrando al portal SRI...');
    let intentosLogin = 0;
    let loginOk = false;
    let ultimoErrorLogin = null;
    while (intentosLogin < 3 && !loginOk) {
      intentosLogin++;
      try {
        console.log(`Intento de login #${intentosLogin}...`);
        await page.goto('https://srienlinea.sri.gob.ec/tuportal-internet/', {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        loginOk = true;
      } catch(errLogin) {
        ultimoErrorLogin = errLogin;
        console.log(`Intento #${intentosLogin} fallo: ${errLogin.message}`);
        if (intentosLogin < 3) {
          console.log('Esperando 5 segundos antes de reintentar...');
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
    if (!loginOk) {
      throw new Error(`No se pudo cargar el portal SRI tras 3 intentos. Ultimo error: ${ultimoErrorLogin.message}`);
    }

    console.log('URL actual:', page.url());
    console.log('Titulo:', await page.title());
    console.log('HTML primeros 500 chars:', (await page.content()).substring(0, 500));
    await page.type('#username', ruc);
    await page.type('#password', clave);
    await page.click('#kc-login');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Login OK');

    // 2. Iterar por fechas
    const facturas = [];
    let htmlCapturado = null;
    const [dDesde, mDesde, yDesde] = fechaDesde.split('/').map(Number);
    const [dHasta, mHasta, yHasta] = fechaHasta.split('/').map(Number);
    const inicio = new Date(yDesde, mDesde-1, dDesde);
    const fin    = new Date(yHasta, mHasta-1, dHasta);

    for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate()+1)) {
      const dd   = String(d.getDate()).padStart(2,'0');
      const mm   = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      const fechaDia = `${dd}/${mm}/${yyyy}`;

      console.log(`Consultando ${fechaDia}...`);

      await page.goto(`https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=60&idGrupo=58`, {
        waitUntil: 'domcontentloaded', timeout: 60000
      });

      console.log('Esperando que Angular renderice...');
      await new Promise(r => setTimeout(r, 8000));

      console.log('DEBUG misComprobantes - URL:', page.url());
      console.log('DEBUG misComprobantes - Titulo:', await page.title());
      const htmlDebug = await page.content();
      console.log('DEBUG misComprobantes - HTML length:', htmlDebug.length);
      if (!htmlCapturado) htmlCapturado = htmlDebug;
      const existeTipoComp = await page.$('#tipoComprobante');
      console.log('DEBUG existe #tipoComprobante:', !!existeTipoComp);
      const existeFecha = await page.$('#fechaEmision');
      console.log('DEBUG existe #fechaEmision:', !!existeFecha);

      // Seleccionar tipo comprobante: Factura (solo si existe, si no seguimos igual para poder ver el HTML)
      await page.waitForSelector('#tipoComprobante', { timeout: 10000 }).catch(()=>{});
      await page.select('#tipoComprobante', '01').catch(()=>{});

      // Ingresar fecha
      await page.$eval('#fechaEmision', (el, v) => { el.value = ''; }, fechaDia).catch(()=>{});
      await page.type('#fechaEmision', fechaDia).catch(()=>{});

      // Consultar
      await page.click('button[type="submit"]').catch(()=>{});
      await page.waitForTimeout(2000);

      // Leer resultados
      const filas = await page.$$eval('table tbody tr', rows =>
        rows.map(r => {
          const celdas = Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim());
          return celdas;
        })
      ).catch(() => []);

      for (const fila of filas) {
        if (fila.length >= 4) {
          facturas.push({
            fecha:            fechaDia,
            numero:           fila[0] || '',
            razonSocial:      fila[1] || '',
            claveAcceso:      fila[2] || '',
            estado:           fila[3] || '',
            fechaAutorizacion: fila[4] || ''
          });
        }
      }
    }

    await browser.close();
    console.log(`Total facturas: ${facturas.length}`);
    res.json({ ok: true, facturas, htmlDebug: htmlCapturado });

  } catch(e) {
    if (browser) await browser.close().catch(()=>{});
    console.error('Error scraping:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 SRIFACTU Scraper corriendo en puerto ${PORT}`);
});
