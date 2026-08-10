export function createFrameSchedule({ fps, multiplier = 1, smooth = false, samplesPerFrame = 5, quantumMs = 0, maxStepDurationMs = Infinity }) {
  const safeFps = Math.max(1, Number(fps) || 1);
  const safeMultiplier = Math.max(0.1, Number(multiplier) || 1);
  const durationMs = (1000 / safeFps) * safeMultiplier;
  let steps = smooth ? Math.max(1, Math.round(samplesPerFrame * safeMultiplier)) : 1;
  if (Number.isFinite(maxStepDurationMs) && maxStepDurationMs > 0) {
    steps = Math.max(steps, Math.ceil(durationMs / maxStepDurationMs));
  }

  if (quantumMs > 0) {
    const totalUnits = Math.max(1, Math.round(durationMs / quantumMs));
    steps = Math.min(steps, totalUnits);
    const baseUnits = Math.floor(totalUnits / steps);
    const remainder = totalUnits % steps;
    return Array.from({ length: steps }, (_, index) => (baseUnits + (index < remainder ? 1 : 0)) * quantumMs);
  }

  return Array.from({ length: steps }, () => durationMs / steps);
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
