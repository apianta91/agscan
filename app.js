/* global PDFLib, exifr, cv */

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');

const snapBtn = document.getElementById('snapBtn');
const switchBtn = document.getElementById('switchBtn');
const resetBtn = document.getElementById('resetBtn');

const pdfBtn = document.getElementById('pdfBtn');
const thumbs = document.getElementById('thumbs');

const stepTitle = document.getElementById('stepTitle');
const stepSub = document.getElementById('stepSub');
const hint = document.getElementById('hint');
const downloadLink = document.getElementById('downloadLink');

const autocropToggle = document.getElementById('autocropToggle');

const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const pagesNum = document.getElementById('pagesNum');

const fileFallback = document.getElementById('fileFallback');
const fallbackBtn = document.getElementById('fallbackBtn');

const HEADER_TEXT = 'Creato con Alto Garda Scan';

let stream = null;
let facingMode = 'environment';
let shots = []; // { blob, url }
let targetPages = 4;

let opencvReady = false;
waitForOpenCV();

/* -------------------- helpers -------------------- */
function setHint(msg){ hint.textContent = msg || ''; }

function updateUI(){
  // page selector UI
  pagesNum.textContent = String(targetPages);
  minusBtn.disabled = targetPages <= 1;
  plusBtn.disabled = targetPages >= 20;

  // status
  const next = Math.min(shots.length + 1, targetPages);
  stepTitle.textContent = `Pagina ${next}`;
  stepSub.textContent = `di ${targetPages}`;

  // thumbs
  thumbs.innerHTML = '';
  shots.forEach((s, idx) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${s.url}" alt="pagina ${idx+1}"><button type="button" aria-label="Rimuovi">✕</button>`;
    d.querySelector('button').onclick = () => removeShot(idx);
    thumbs.appendChild(d);
  });

  pdfBtn.disabled = shots.length !== targetPages;

  downloadLink.hidden = true;
  downloadLink.removeAttribute('href');
  downloadLink.removeAttribute('download');
}

function removeShot(i){
  const s = shots[i];
  if (s?.url) URL.revokeObjectURL(s.url);
  shots.splice(i, 1);
  updateUI();
  setHint(`Rimossa. Ora hai ${shots.length}/${targetPages}.`);
}

function resetAll(){
  shots.forEach(s => s?.url && URL.revokeObjectURL(s.url));
  shots = [];
  updateUI();
  setHint(opencvReady
    ? 'Pronto. Inquadra il foglio e scatta. (Consiglio: luce uniforme)'
    : 'Pronto. Auto-crop in caricamento… puoi scattare lo stesso.'
  );
}

function dataURLtoBlob(dataURL){
  const [head, body] = dataURL.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for(let i=0;i<len;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function blobToArrayBuffer(blob){ return await blob.arrayBuffer(); }

/* -------------------- camera -------------------- */
async function stopCamera(){
  if (stream){
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

async function startCamera(){
  await stopCamera();

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };

  try{
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    fallbackBtn.classList.add('hidden');
    setHint(opencvReady ? 'Inquadra e premi “Scatta”.' : 'Inquadra e scatta (auto-crop in arrivo)…');
  }catch(e){
    setHint('Camera non disponibile qui. Usa il pulsante “fallback”.');
    fallbackBtn.classList.remove('hidden');
  }
}

async function captureFrameAsBlob(){
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  return dataURLtoBlob(canvas.toDataURL('image/jpeg', 0.92));
}

/* -------------------- shots -------------------- */
async function addShotFromBlob(blob){
  if (shots.length >= targetPages) return;

  const url = URL.createObjectURL(blob);
  shots.push({ blob, url });
  updateUI();

  if (shots.length === targetPages){
    setHint('Ok! Premi “PDF” per generare il file.');
  } else {
    setHint(`Acquisita: ${shots.length}/${targetPages}. Prossima pagina…`);
  }
}

/* -------------------- EXIF orientation -------------------- */
async function normalizeOrientation(arrayBuffer){
  let orientation = 1;
  try{ orientation = await exifr.orientation(arrayBuffer) || 1; } catch(_){}

  let rotation = 0;
  if (orientation === 3) rotation = 180;
  if (orientation === 6) rotation = 90;
  if (orientation === 8) rotation = 270;

  return { bytes: new Uint8Array(arrayBuffer), rotation };
}

/* -------------------- OpenCV: auto-crop + perspective -------------------- */
function waitForOpenCV(){
  const t = setInterval(() => {
    if (typeof cv !== 'undefined' && cv?.Mat){
      clearInterval(t);
      if (cv?.onRuntimeInitialized){
        cv.onRuntimeInitialized = () => {
          opencvReady = true;
          setHint('Auto-crop pronto. Inquadra il foglio e scatta.');
        };
      } else {
        opencvReady = true;
        setHint('Auto-crop pronto. Inquadra il foglio e scatta.');
      }
    }
  }, 100);
}

function orderQuadPoints(pts){
  const sum = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.x - p.y);

  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];

  return [tl, tr, br, bl];
}

function dist(a,b){
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

async function autoCropAndCorrect(blob){
  if (!autocropToggle.checked) return blob;
  if (!opencvReady) return blob;

  const ab = await blobToArrayBuffer(blob);
  const u8 = new Uint8Array(ab);

  let src=null, rgba=null, gray=null, blurred=null, edges=null, contours=null, hierarchy=null;

  try{
    src = cv.imdecode(u8); // BGR
    rgba = new cv.Mat();
    cv.cvtColor(src, rgba, cv.COLOR_BGR2RGBA);

    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);

    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5,5), 0);

    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best=null, bestArea=0;
    const imgArea = src.rows * src.cols;

    for (let i=0; i<contours.size(); i++){
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4){
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > imgArea * 0.20){
          bestArea = area;
          best = approx.clone();
        }
      }

      approx.delete();
      cnt.delete();
    }

    if (!best) return blob;

    const pts = [];
    for (let r=0; r<4; r++){
      pts.push({ x: best.intAt(r,0), y: best.intAt(r,1) });
    }
    best.delete();

    const [tl,tr,br,bl] = orderQuadPoints(pts);

    const maxW = Math.max(dist(br,bl), dist(tr,tl));
    const maxH = Math.max(dist(tr,br), dist(tl,bl));
    const dsize = new cv.Size(Math.round(maxW), Math.round(maxH));

    const srcTri = cv.matFromArray(4,1,cv.CV_32FC2, [
      tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
    ]);
    const dstTri = cv.matFromArray(4,1,cv.CV_32FC2, [
      0,0, dsize.width-1,0, dsize.width-1,dsize.height-1, 0,dsize.height-1
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);

    const warped = new cv.Mat();
    cv.warpPerspective(rgba, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    // contrastino (equalize su gray) per effetto “scanner”
    const warpedBGR = new cv.Mat();
    cv.cvtColor(warped, warpedBGR, cv.COLOR_RGBA2BGR);

    const warpedGray = new cv.Mat();
    cv.cvtColor(warpedBGR, warpedGray, cv.COLOR_BGR2GRAY);

    const eq = new cv.Mat();
    cv.equalizeHist(warpedGray, eq);

    const outRGBA = new cv.Mat();
    cv.cvtColor(eq, outRGBA, cv.COLOR_GRAY2RGBA);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outRGBA.cols;
    outCanvas.height = outRGBA.rows;
    cv.imshow(outCanvas, outRGBA);

    const outBlob = dataURLtoBlob(outCanvas.toDataURL('image/jpeg', 0.92));

    // cleanup
    srcTri.delete(); dstTri.delete(); M.delete();
    warped.delete(); warpedBGR.delete(); warpedGray.delete(); eq.delete(); outRGBA.delete();

    return outBlob;
  } catch(e){
    console.warn('autoCropAndCorrect fallback:', e);
    return blob;
  } finally {
    try{ src?.delete(); }catch(_){}
    try{ rgba?.delete(); }catch(_){}
    try{ gray?.delete(); }catch(_){}
    try{ blurred?.delete(); }catch(_){}
    try{ edges?.delete(); }catch(_){}
    try{ contours?.delete(); }catch(_){}
    try{ hierarchy?.delete(); }catch(_){}
  }
}

/* -------------------- PDF (full-bleed + header centered) -------------------- */
async function generatePdf(){
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.create();

  // "font carino": Helvetica Bold è pulito e molto leggibile
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const A4 = { w: 595.28, h: 841.89 };

  for (let i=0; i<shots.length; i++){
    const ab = await blobToArrayBuffer(shots[i].blob);
    const { bytes, rotation } = await normalizeOrientation(ab);

    let img;
    try{ img = await pdfDoc.embedJpg(bytes); }
    catch(_){ img = await pdfDoc.embedPng(bytes); }

    const page = pdfDoc.addPage([A4.w, A4.h]);

    // 1) immagine FULL BLEED: scala "cover" (senza bordi)
    const pw = A4.w, ph = A4.h;

    const iw = img.width, ih = img.height;
    const rw = (rotation === 90 || rotation === 270) ? ih : iw;
    const rh = (rotation === 90 || rotation === 270) ? iw : ih;

    const scale = Math.max(pw / rw, ph / rh); // cover => zero bordi
    const drawW = rw * scale;
    const drawH = rh * scale;

    const x = (pw - drawW) / 2;
    const y = (ph - drawH) / 2;

    if (rotation === 0){
      page.drawImage(img, { x, y, width: drawW, height: drawH });
    } else if (rotation === 90){
      page.drawImage(img, {
        x: x + drawW, y,
        width: drawH, height: drawW,
        rotate: PDFLib.degrees(90)
      });
    } else if (rotation === 180){
      page.drawImage(img, {
        x: x + drawW, y: y + drawH,
        width: drawW, height: drawH,
        rotate: PDFLib.degrees(180)
      });
    } else if (rotation === 270){
      page.drawImage(img, {
        x, y: y + drawH,
        width: drawH, height: drawW,
        rotate: PDFLib.degrees(270)
      });
    }

    // 2) header centrato IN ALTO, sopra immagine (band per leggibilità)
    const bandH = 28;
    page.drawRectangle({
      x: 0, y: ph - bandH,
      width: pw, height: bandH,
      color: rgb(1, 1, 1)
    });

    const textSize = 12;
    const textWidth = font.widthOfTextAtSize(HEADER_TEXT, textSize);
    const tx = Math.max(0, (pw - textWidth) / 2);
    const ty = ph - bandH + 8;

    page.drawText(HEADER_TEXT, {
      x: tx,
      y: ty,
      size: textSize,
      font,
      color: rgb(0.10, 0.15, 0.25)
    });
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

/* -------------------- events -------------------- */
minusBtn.addEventListener('click', () => {
  if (targetPages <= 1) return;
  targetPages -= 1;

  // se hai più scatti del nuovo target, taglia
  while (shots.length > targetPages){
    const s = shots.pop();
    if (s?.url) URL.revokeObjectURL(s.url);
  }
  updateUI();
  setHint(`Impostato a ${targetPages} pagine.`);
});

plusBtn.addEventListener('click', () => {
  if (targetPages >= 20) return;
  targetPages += 1;
  updateUI();
  setHint(`Impostato a ${targetPages} pagine.`);
});

resetBtn.addEventListener('click', resetAll);

switchBtn.addEventListener('click', async () => {
  facingMode = (facingMode === 'environment') ? 'user' : 'environment';
  await startCamera();
});

snapBtn.addEventListener('click', async () => {
  if (shots.length >= targetPages) return;

  try{
    setHint('Scatto…');
    const rawBlob = await captureFrameAsBlob();

    let finalBlob = rawBlob;
    if (autocropToggle.checked){
      setHint(opencvReady ? 'Auto-crop…' : 'Auto-crop non pronto, salvo originale…');
      finalBlob = await autoCropAndCorrect(rawBlob);
    }

    await addShotFromBlob(finalBlob);
  }catch(e){
    console.error(e);
    setHint('Errore nello scatto. Prova col fallback.');
    fallbackBtn.classList.remove('hidden');
  }
});

// fallback
fallbackBtn.addEventListener('click', () => fileFallback.click());
fileFallback.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;

  try{
    setHint('Importo…');
    let finalBlob = file;
    if (autocropToggle.checked){
      setHint(opencvReady ? 'Auto-crop…' : 'Auto-crop non pronto, salvo originale…');
      finalBlob = await autoCropAndCorrect(file);
    }
    await addShotFromBlob(finalBlob);
  }catch(e){
    console.error(e);
    setHint('Errore import. Riprova.');
  }
});

pdfBtn.addEventListener('click', async () => {
  try{
    setHint('Genero PDF…');
    const pdfBlob = await generatePdf();
    const url = URL.createObjectURL(pdfBlob);

    const filename = `alto-garda-scan-${new Date().toISOString().slice(0,10)}.pdf`;
    downloadLink.hidden = false;
    downloadLink.href = url;
    downloadLink.download = filename;

    const file = new File([pdfBlob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ title: 'Alto Garda Scan', files: [file] });
      setHint('PDF pronto. Puoi anche scaricarlo dal pulsante “Scarica”.');
    } else {
      setHint('PDF pronto. Tocca “Scarica”. Su iPhone: poi “Salva su File”.');
    }
  }catch(e){
    console.error(e);
    setHint('Errore nella generazione del PDF. Riprova.');
  }
});

/* -------------------- boot -------------------- */
updateUI();
resetAll();
startCamera();
