// streaming.js
// Bepaalt hoe een bronvideo geschikt gemaakt wordt om vlot in de browser af te spelen.
//
// Puur remuxen (de oude aanpak) zet alleen de moov-atom vooraan, maar laat de
// bitrate ongemoeid: een telefoonvideo van 4K/45 Mbit/s blijft dan 45 Mbit/s en
// hapert op mobiel internet. Voor zulke bronnen maken we daarom één keer een
// webversie met een beheersbare bitrate; al webvriendelijke bronnen blijven
// gewoon een snelle remux zonder kwaliteitsverlies.
//
// De keuzes hieronder zijn pure functies, zodat ze zonder ffmpeg getest kunnen
// worden; onderaan staan de ffmpeg-aanroepen die generate.js en refresh.js delen.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
// ffmpeg kan veel naar stderr schrijven; een ruime buffer voorkomt dat een lange
// video het kindproces laat afbreken.
const FFMPEG_OPTIONS = { maxBuffer: 32 * 1024 * 1024 };

const WEB_VIDEO_CODECS = new Set(["h264", "avc1"]);
const WEB_AUDIO_CODECS = new Set(["aac", "mp3"]);

const DEFAULT_LIMITS = {
  transcode: true,
  maxShortSide: 1080, // korte zijde: staande telefoonvideo's houden hun breedte
  maxBitrateKbps: 4500,
  preset: "veryfast",
  crf: 23,
  audioBitrateKbps: 128,
};

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function limitsFromEnv(env = process.env) {
  return {
    transcode: env.STREAM_TRANSCODE !== "off",
    maxShortSide: positiveNumber(env.STREAM_MAX_HEIGHT, DEFAULT_LIMITS.maxShortSide),
    maxBitrateKbps: positiveNumber(env.STREAM_MAX_BITRATE_KBPS, DEFAULT_LIMITS.maxBitrateKbps),
    preset: env.STREAM_PRESET || DEFAULT_LIMITS.preset,
    crf: positiveNumber(env.STREAM_CRF, DEFAULT_LIMITS.crf),
    audioBitrateKbps: positiveNumber(env.STREAM_AUDIO_BITRATE_KBPS, DEFAULT_LIMITS.audioBitrateKbps),
  };
}

// Leest de eigenschappen van een bron uit de stderr die ffmpeg over zijn invoer
// print. Zo is er geen aparte ffprobe nodig naast de ffmpeg die er al is.
function parseProbe(stderr, fileSizeBytes = 0) {
  const text = String(stderr || "");
  const duration = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const durationSeconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : 0;
  const containerBitrate = text.match(/Duration:[^\n]*?bitrate:\s*(\d+)\s*kb\/s/);
  const videoLine = text.match(/Stream #\d+:\d+[^\n]*: Video: [^\n]*/);
  const audioLine = text.match(/Stream #\d+:\d+[^\n]*: Audio: [^\n]*/);
  const videoCodec = videoLine ? (videoLine[0].match(/Video: ([A-Za-z0-9_]+)/) || [])[1] : undefined;
  const audioCodec = audioLine ? (audioLine[0].match(/Audio: ([A-Za-z0-9_]+)/) || [])[1] : undefined;
  const resolution = videoLine ? videoLine[0].match(/(?<![\dx])(\d{2,5})x(\d{2,5})(?![\dx])/) : null;
  const videoBitrate = videoLine ? videoLine[0].match(/,\s*(\d+)\s*kb\/s/) : null;
  const audioBitrate = audioLine ? audioLine[0].match(/,\s*(\d+)\s*kb\/s/) : null;

  if (!videoLine) return null; // Geen leesbare videostream: laat de oude, veilige route beslissen.

  const measured = durationSeconds > 0 && fileSizeBytes > 0
    ? Math.round((fileSizeBytes * 8) / durationSeconds / 1000)
    : 0;
  const bitrateKbps = Number(videoBitrate?.[1])
    || (containerBitrate ? Number(containerBitrate[1]) - Number(audioBitrate?.[1] || 0) : 0)
    || measured;

  return {
    videoCodec: videoCodec ? videoCodec.toLowerCase() : undefined,
    audioCodec: audioCodec ? audioCodec.toLowerCase() : undefined,
    width: resolution ? Number(resolution[1]) : 0,
    height: resolution ? Number(resolution[2]) : 0,
    durationSeconds,
    bitrateKbps: bitrateKbps > 0 ? bitrateKbps : 0,
  };
}

// Kiest tussen een snelle remux ("copy") en één keer her-encoderen ("transcode").
function chooseStreamPlan(probe, limits = DEFAULT_LIMITS) {
  const reasons = [];
  if (!limits.transcode || !probe) return { mode: "copy", reasons };

  const shortSide = Math.min(probe.width || 0, probe.height || 0);
  if (probe.videoCodec && !WEB_VIDEO_CODECS.has(probe.videoCodec)) reasons.push(`codec ${probe.videoCodec}`);
  if (probe.audioCodec && !WEB_AUDIO_CODECS.has(probe.audioCodec)) reasons.push(`audio ${probe.audioCodec}`);
  if (shortSide > limits.maxShortSide) reasons.push(`${probe.width}x${probe.height}`);
  if (probe.bitrateKbps > limits.maxBitrateKbps) reasons.push(`${probe.bitrateKbps} kb/s`);

  return { mode: reasons.length ? "transcode" : "copy", reasons };
}

function describePlan(plan, limits = DEFAULT_LIMITS) {
  if (plan.mode === "copy") return "remux zonder her-encoderen";
  return `her-encodeerd naar max ${limits.maxShortSide}p en ${limits.maxBitrateKbps} kb/s (bron: ${plan.reasons.join(", ")})`;
}

// -nostats: ffmpeg schrijft anders per seconde voortgang naar stderr, wat bij
// een lange video de uitvoerbuffer van het kindproces laat vollopen.
function remuxArgs(inputPath, outputPath) {
  return ["-y", "-nostats", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", outputPath];
}

// Eén rendition die overal speelt: H.264/AAC, korte zijde begrensd, bitrate
// afgetopt en keyframes elke 2 seconden zodat spoelen snel blijft reageren.
function transcodeArgs(inputPath, outputPath, limits = DEFAULT_LIMITS) {
  const side = Math.round(limits.maxShortSide);
  const scale = `scale=w='if(gt(iw,ih),-2,min(iw,${side}))':h='if(gt(iw,ih),min(ih,${side}),-2)'`;
  return [
    "-y",
    "-nostats",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", scale,
    "-c:v", "libx264",
    "-preset", String(limits.preset),
    "-crf", String(Math.round(limits.crf)),
    "-maxrate", `${Math.round(limits.maxBitrateKbps)}k`,
    "-bufsize", `${Math.round(limits.maxBitrateKbps) * 2}k`,
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    "-g", "48",
    "-keyint_min", "48",
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", `${Math.round(limits.audioBitrateKbps)}k`,
    "-ac", "2",
    "-movflags", "+faststart",
    outputPath,
  ];
}

async function runFfmpeg(args) {
  return execFileAsync("ffmpeg", args, FFMPEG_OPTIONS);
}

// Leest codec, resolutie en bitrate uit de stderr van een ultrakorte ffmpeg-run.
// Zo is er geen losse ffprobe nodig naast de ffmpeg die er al is.
async function probeFile(filePath) {
  try {
    const { stderr } = await runFfmpeg(["-hide_banner", "-nostats", "-i", filePath, "-t", "0.1", "-f", "null", "-"]);
    return parseProbe(stderr, fs.statSync(filePath).size);
  } catch (error) {
    console.warn(`Kon eigenschappen van ${path.basename(filePath)} niet lezen: ${error.message}`);
    return null;
  }
}

// Staat de moov-atom vóór de mediadata? Dan kan de browser direct beginnen met
// afspelen in plaats van eerst (bijna) het hele bestand te downloaden.
function hasFastStart(filePath) {
  let file;
  try {
    file = fs.openSync(filePath, "r");
    const header = Buffer.alloc(16);
    for (let offset = 0, atoms = 0; atoms < 32; atoms++) {
      if (fs.readSync(file, header, 0, 16, offset) < 8) return false;
      const name = header.toString("latin1", 4, 8);
      if (name === "moov") return true;
      if (name === "mdat") return false;
      // Een grootte van 1 betekent dat de echte grootte in de volgende 8 bytes staat.
      const size = header.readUInt32BE(0) === 1 ? Number(header.readBigUInt64BE(8)) : header.readUInt32BE(0);
      if (!(size >= 8)) return false;
      offset += size;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}

module.exports = { DEFAULT_LIMITS, limitsFromEnv, parseProbe, chooseStreamPlan, describePlan, remuxArgs, transcodeArgs, runFfmpeg, probeFile, hasFastStart };
