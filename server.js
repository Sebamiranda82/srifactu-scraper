'use strict';
const express    = require('express');
const cors       = require('cors');
const puppeteer  = require('puppeteer');

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

    // 1. Login SRI
    console.log('Entrando al portal SRI...');
    await page.goto('https://srienlinea.sri.gob.ec/auth/realms/Internet/protocol/openid-connect/auth?client_id=app-internet&redirect_uri=https%3A%2F%2Fsrienlinea.sri.gob.ec%2Fsri-en-linea%2F%23%2FmisComprobantes&response_type=code&scope=openid', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });

    await page.type('#username', ruc);
    await page.type('#password', clave);
    await page.click('#kc-login');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Login OK');

    // 2. Iterar por fechas
    const facturas = [];
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

      await page.goto(`https://srienlinea.sri.gob.ec/sri-en-linea/#/misComprobantes`, {
        waitUntil: 'domcontentloaded', timeout: 60000
      });

      // Seleccionar tipo comprobante: Factura
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
    res.json({ ok: true, facturas });

  } catch(e) {
    if (browser) await browser.close().catch(()=>{});
    console.error('Error scraping:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 SRIFACTU Scraper corriendo en puerto ${PORT}`);
});
