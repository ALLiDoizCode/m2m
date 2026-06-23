import * as THREE from 'three';

/**
 * Procedural fallback label drawn to a canvas so the scene renders even before
 * the user drops their real product photo at /public/bottle-label.png.
 * Approximates the Bint Hooran front: gold Arabic calligraphy + latin name on
 * a black-to-amber field.
 */
export function makeFallbackLabel(): THREE.CanvasTexture {
  const w = 512;
  const h = 768;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#050505');
  grad.addColorStop(0.55, '#1a1206');
  grad.addColorStop(0.8, '#8a5a1e');
  grad.addColorStop(1, '#e9d7b0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // gold "calligraphy" flourish (stylised, not real script)
  ctx.strokeStyle = '#d8b25a';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(110, 300);
  ctx.bezierCurveTo(200, 220, 320, 380, 410, 290);
  ctx.moveTo(150, 360);
  ctx.bezierCurveTo(240, 300, 300, 430, 380, 360);
  ctx.stroke();

  ctx.fillStyle = '#e7c976';
  ctx.font = 'bold 54px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('BINT', w / 2, 560);
  ctx.fillText('HOORAN', w / 2, 620);

  ctx.fillStyle = '#caa860';
  ctx.font = '20px Georgia, serif';
  ctx.fillText('EAU DE PARFUM', w / 2, 670);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Black->amber->clear gradient for the "liquid" inside the glass. */
export function makeLiquidTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0a0a0a');
  grad.addColorStop(0.5, '#26190a');
  grad.addColorStop(0.82, '#9c6a24');
  grad.addColorStop(1, '#f0e4c4');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Gold geometric chevron pattern for the presentation box. */
export function makeBoxPattern(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c9a24b';
  ctx.fillRect(0, 0, s, s);
  // mottled foil
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 3, 3);
  }
  // white chevrons
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 4;
  for (let k = -s; k < s; k += 48) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + s / 2, s);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
