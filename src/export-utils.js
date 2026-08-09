function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function number(value) {
  return Number(value.toFixed(3));
}

function defaultWrapText(value) {
  return [String(value || 'Say something')];
}

function figureToSvg(figure, wrapText) {
  figure.updatePositions();
  const color = escapeXml(figure.color || '#000000');
  if (figure.type === 'text') {
    const handle = figure.joints.find(joint => joint.id === 'handle');
    const angle = handle ? Math.atan2(handle.y - figure.y, handle.x - figure.x) : 0;
    const scale = handle ? Math.hypot(handle.x - figure.x, handle.y - figure.y) / 20 : figure.scale || 1;
    return `<g transform="translate(${number(figure.x)} ${number(figure.y)}) rotate(${number(angle * 180 / Math.PI)}) scale(${number(scale)})"><text x="0" y="0" fill="${color}" font-family="system-ui, sans-serif" font-size="20" font-weight="600" text-anchor="middle" dominant-baseline="middle">${escapeXml(figure.text)}</text></g>`;
  }
  if (figure.type === 'speech') {
    const handle = figure.joints.find(joint => joint.id === 'handle');
    const tail = figure.joints.find(joint => joint.id === 'tail');
    const angle = handle ? Math.atan2(handle.y - figure.y, handle.x - figure.x) : 0;
    const scale = handle ? Math.hypot(handle.x - figure.x, handle.y - figure.y) / 40 : figure.scale || 1;
    const tailTipX = tail ? Math.cos(tail.angle) * tail.length : -72;
    const tailTipY = tail ? Math.sin(tail.angle) * tail.length : 77;
    const lines = wrapText(figure.text || 'Say something', 146).slice(0, 5);
    const startY = -(lines.length - 1) * 10 - 1;
    const text = lines.map((line, index) => `<tspan x="0" y="${number(startY + index * 20)}">${escapeXml(line)}</tspan>`).join('');
    const path = `M -72 -47 H 72 Q 90 -47 90 -29 V 29 Q 90 47 72 47 H -10 L ${number(tailTipX)} ${number(tailTipY)} L -38 47 H -72 Q -90 47 -90 29 V -29 Q -90 -47 -72 -47 Z`;
    return `<g transform="translate(${number(figure.x)} ${number(figure.y)}) rotate(${number(angle * 180 / Math.PI)}) scale(${number(scale)})"><path d="${path}" fill="#ffffff" stroke="${color}" stroke-width="4" stroke-linejoin="round"/><text fill="${color}" font-family="system-ui, sans-serif" font-size="17" font-weight="600" text-anchor="middle" dominant-baseline="middle">${text}</text></g>`;
  }

  const parts = [];
  for (const joint of figure.joints) {
    if (joint.parentId === null) continue;
    const parent = figure.joints.find(item => item.id === joint.parentId);
    if (!parent) continue;
    const partColor = escapeXml(joint.color || figure.color || '#000000');
    const thickness = number((joint.thickness || 14) * figure.scale);
    if (joint.type === 'circle') {
      const radius = number((joint.radius || 20) * figure.scale);
      if (joint.length > 2) {
        const angle = Math.atan2(joint.y - parent.y, joint.x - parent.x);
        const edgeX = joint.x - Math.cos(angle) * radius;
        const edgeY = joint.y - Math.sin(angle) * radius;
        parts.push(`<line x1="${number(parent.x)}" y1="${number(parent.y)}" x2="${number(edgeX)}" y2="${number(edgeY)}" stroke="${partColor}" stroke-width="${thickness}" stroke-linecap="round"/>`);
      }
      const fill = joint.filled === false ? 'none' : partColor;
      const stroke = joint.filled === false ? partColor : 'none';
      parts.push(`<circle cx="${number(joint.x)}" cy="${number(joint.y)}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${thickness}"/>`);
    } else {
      parts.push(`<line x1="${number(parent.x)}" y1="${number(parent.y)}" x2="${number(joint.x)}" y2="${number(joint.y)}" stroke="${partColor}" stroke-width="${thickness}" stroke-linecap="round"/>`);
    }
  }
  return parts.join('');
}

export function createSvgArtwork({ width, height, figures, backgroundData = null, wrapText = defaultWrapText }) {
  const background = [`<rect width="${width}" height="${height}" fill="#ffffff"/>`];
  if (backgroundData) background.push(`<image href="${escapeXml(backgroundData)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>`);
  const artwork = figures.map(figure => figureToSvg(figure, wrapText)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background.join('')}${artwork}</svg>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function view(length) {
  const bytes = new Uint8Array(length);
  return { bytes, data: new DataView(bytes.buffer) };
}

export async function createStoredZip(files, modifiedAt = new Date()) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime(modifiedAt);
  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer());
    const checksum = crc32(bytes);
    const local = view(30 + name.length);
    local.data.setUint32(0, 0x04034b50, true);
    local.data.setUint16(4, 20, true);
    local.data.setUint16(8, 0, true);
    local.data.setUint16(10, stamp.time, true);
    local.data.setUint16(12, stamp.date, true);
    local.data.setUint32(14, checksum, true);
    local.data.setUint32(18, bytes.length, true);
    local.data.setUint32(22, bytes.length, true);
    local.data.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    localParts.push(local.bytes, bytes);

    const central = view(46 + name.length);
    central.data.setUint32(0, 0x02014b50, true);
    central.data.setUint16(4, 20, true);
    central.data.setUint16(6, 20, true);
    central.data.setUint16(10, 0, true);
    central.data.setUint16(12, stamp.time, true);
    central.data.setUint16(14, stamp.date, true);
    central.data.setUint32(16, checksum, true);
    central.data.setUint32(20, bytes.length, true);
    central.data.setUint32(24, bytes.length, true);
    central.data.setUint16(28, name.length, true);
    central.data.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    centralParts.push(central.bytes);
    offset += local.bytes.length + bytes.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = view(22);
  end.data.setUint32(0, 0x06054b50, true);
  end.data.setUint16(8, files.length, true);
  end.data.setUint16(10, files.length, true);
  end.data.setUint32(12, centralSize, true);
  end.data.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end.bytes], { type: 'application/zip' });
}

export function pickWebmMimeType(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass) return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find(type => !MediaRecorderClass.isTypeSupported || MediaRecorderClass.isTypeSupported(type)) || '';
}
