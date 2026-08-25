// deno-lint-ignore-file no-explicit-any
// Sonos S1 YouTube Player - Interactive CLI
// Usage: deno compile --allow-net --allow-run --allow-env --allow-read --allow-write --allow-sys -o sonos-cli sonos-youtube-cli.ts

import { parse } from "https://deno.land/std@0.208.0/flags/mod.ts";
import { ensureDir } from "https://deno.land/std@0.208.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

// ============= Types =============
interface SonosDevice {
  ip: string;
  name: string;
  model: string;
  room: string;
  uuid?: string;
  lastSeen: string;
}

interface MusicEntry {
  name: string;
  url: string;
  title?: string;
  artist?: string;
  duration?: number;
  addedAt: string;
}

interface Config {
  defaultDevice?: string;
  devices: SonosDevice[];
  musicCatalog: MusicEntry[];
  httpPort?: number;
  lastScan?: string;
}

interface VideoMetadata {
  title: string;
  uploader: string;
  duration: number;
  thumbnail?: string;
  description?: string;
}

interface PlaybackState {
  isPlaying: boolean;
  isPaused?: boolean;
  currentUrl?: string;
  currentMetadata?: VideoMetadata;
  currentDevice?: SonosDevice;
  serverController?: AbortController;
  server?: { shutdown(): Promise<void> };
  streamActive?: boolean;
  activeProcesses?: { ytdlp?: Deno.ChildProcess; ffmpeg?: Deno.ChildProcess; downloader?: Deno.ChildProcess };
  streamListeners?: Set<(chunk: Uint8Array) => void>;
  streamPreroll?: Uint8Array[];
  lastPosition?: number;
  positionUpdateInterval?: number;
  cachedFilePath?: string;
  downloadInProgress?: boolean;
  useFileStream?: boolean;
  lastPositionLogTime?: number;
}

// ============= Global State =============
const CONFIG_DIR = join(Deno.env.get("HOME") || ".", ".sonos-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CACHE_DIR = join(CONFIG_DIR, "cache");
const STREAM_PATH = "/stream";
const STREAM_FILE_PATH = "/stream.mp3";
let config: Config = { devices: [], musicCatalog: [] };
let playbackState: PlaybackState = { isPlaying: false };

// ============= Logging =============
let logFile: Deno.FsFile | null = null;
const LOG_FILE = "sonos-cli.log";

async function initLogging(): Promise<void> {
  try {
    logFile = await Deno.open(LOG_FILE, { create: true, append: true, write: true });
    await log(`=== Session started at ${new Date().toISOString()} ===`);
  } catch (e) {
    console.error(`Failed to open log file: ${e}`);
  }
}

async function log(message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  if (logFile) {
    try {
      const encoder = new TextEncoder();
      await logFile.write(encoder.encode(logMessage));
      if (typeof logFile.sync === "function") {
        await logFile.sync();
      }
    } catch (e) {
      console.error(`Failed to write to log file: ${e}`);
    }
  }
  
  if (typeof tuiEnabled !== 'undefined' && !tuiEnabled) {
    console.log(logMessage.trim());
  }
}

async function closeLogging(): Promise<void> {
  if (logFile) {
    await log(`=== Session ended at ${new Date().toISOString()} ===`);
    logFile.close();
    logFile = null;
  }
}

// ============= Configuration Management =============
async function loadConfig(): Promise<void> {
  try {
    await ensureDir(CONFIG_DIR);
    await ensureDir(CACHE_DIR);
    const data = await Deno.readTextFile(CONFIG_FILE);
    config = JSON.parse(data);
    if (!config.musicCatalog) {
      config.musicCatalog = [];
    }
  } catch {
    config = { devices: [], musicCatalog: [] };
    await ensureDir(CACHE_DIR);
  }
}

async function saveConfig(): Promise<void> {
  await ensureDir(CONFIG_DIR);
  await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============= Network Discovery =============
async function getNetworkInterfaces(): Promise<string[]> {
  const ips: string[] = [];
  try {
    const interfaces = (Deno as any).networkInterfaces?.() ?? [];
    for (const nic of interfaces) {
      if (nic.family === "IPv4" && !nic.internal && !nic.address.startsWith("127.")) {
        ips.push(nic.address);
      }
    }
  } catch {
    ips.push(getLocalIPv4() || "0.0.0.0");
  }
  return ips.length > 0 ? ips : ["0.0.0.0"];
}

function getLocalIPv4(): string | null {
  const ifs: any = (Deno as any).networkInterfaces?.() ?? [];
  for (const nic of ifs) {
    if (nic.family === "IPv4" && !nic.internal && !nic.address.startsWith("127.")) {
      return nic.address;
    }
  }
  return null;
}

async function discoverSonosDevices(timeoutMs = 5000, verbose = false): Promise<SonosDevice[]> {
  const devices = new Map<string, SonosDevice>();
  
  if (verbose) {
    console.log(`🔍 Scanning for Sonos devices via Bonjour/mDNS...`);
    console.log(`⏱️  Timeout: ${timeoutMs}ms`);
  }

  try {
    const instanceNames = await browseSonosServices(timeoutMs, verbose);
    
    if (instanceNames.length === 0) {
      if (verbose) console.log("⚠️  No Sonos devices found via Bonjour");
    } else {
      if (verbose) console.log(`📡 Found ${instanceNames.length} Sonos service(s)`);
      
      for (const instanceName of instanceNames) {
        try {
          const hostname = await lookupSonosHostname(instanceName, verbose);
          if (!hostname) continue;
          
          const ip = await resolveHostnameToIP(hostname, verbose);
          if (!ip) continue;
          
          if (!devices.has(ip)) {
            const device = await fetchDeviceInfo(ip);
            devices.set(ip, device);
            if (verbose) console.log(`✓ Discovered: ${device.name} at ${ip}`);
          }
        } catch (e) {
          if (verbose) console.log(`⚠️  Error processing ${instanceName}: ${e}`);
        }
      }
    }
  } catch (e) {
    if (verbose) console.log(`⚠️  Discovery error: ${e}`);
  }
  
  if (config.devices.length > 0 && verbose) {
    console.log("📋 Verifying previously saved devices...");
  }
  
  for (const saved of config.devices) {
    if (!devices.has(saved.ip)) {
      const verified = await verifyDevice(saved.ip);
      if (verified) {
        devices.set(saved.ip, { ...saved, lastSeen: new Date().toISOString() });
        if (verbose) console.log(`✓ Found saved device: ${saved.name} at ${saved.ip}`);
      }
    }
  }

  return Array.from(devices.values());
}

async function browseSonosServices(timeoutMs: number, verbose: boolean): Promise<string[]> {
  const instanceNames = new Set<string>();
  
  try {
    const cmd = new Deno.Command("dns-sd", {
      args: ["-B", "_sonos._tcp", "local"],
      stdout: "piped",
      stderr: "piped",
    });
    
    const process = cmd.spawn();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    
    const timeout = setTimeout(() => {
      process.kill();
    }, timeoutMs);
    
    let buffer = "";
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line.includes("Instance Name") || line.includes("STARTING") || line.includes("DATE:")) {
            continue;
          }
          
          // Parse lines like: " 0:16:34.487  Add        3  14 local.               _sonos._tcp.         Sonos-B8E9372FF50E"
          // Format: timestamp  A/R  flags  if  domain  service_type  instance_name
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 7) {
            const action = parts[1];
            const instanceName = parts[parts.length - 1];
            
            if (instanceName && instanceName.startsWith("Sonos-")) {
              if (action === "Add") {
                instanceNames.add(instanceName);
                if (verbose) console.log(`  Found service: ${instanceName}`);
              } else if (action === "Rmv") {
                instanceNames.delete(instanceName);
              }
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      process.kill();
    }
  } catch (e) {
    if (verbose) console.log(`⚠️  Error browsing services: ${e}`);
  }
  
  return Array.from(instanceNames);
}

async function lookupSonosHostname(instanceName: string, verbose: boolean): Promise<string | null> {
  try {
    const cmd = new Deno.Command("dns-sd", {
      args: ["-L", instanceName, "_sonos._tcp", "local"],
      stdout: "piped",
      stderr: "piped",
    });
    
    const process = cmd.spawn();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    
    const timeout = setTimeout(() => {
      process.kill();
    }, 3000);
    
    let buffer = "";
    let hostname: string | null = null;
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          const match = line.match(/can be reached at\s+([a-zA-Z0-9-]+\.local\.?)/);
          if (match) {
            hostname = match[1].replace(/\.$/, "");
            if (verbose) console.log(`  Resolved ${instanceName} → ${hostname}`);
            break;
          }
        }
        
        if (hostname) break;
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      process.kill();
    }
    
    return hostname;
  } catch (e) {
    if (verbose) console.log(`⚠️  Error looking up hostname for ${instanceName}: ${e}`);
    return null;
  }
}

async function resolveHostnameToIP(hostname: string, verbose: boolean): Promise<string | null> {
  try {
    const cmd = new Deno.Command("dns-sd", {
      args: ["-G", "v4v6", hostname],
      stdout: "piped",
      stderr: "piped",
    });
    
    const process = cmd.spawn();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    
    const timeout = setTimeout(() => {
      process.kill();
    }, 3000);
    
    let buffer = "";
    let ip: string | null = null;
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          const match = line.match(/\s+(\d+\.\d+\.\d+\.\d+)\s+\d+/);
          if (match) {
            ip = match[1];
            if (verbose) console.log(`  Resolved ${hostname} → ${ip}`);
            break;
          }
        }
        
        if (ip) break;
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      process.kill();
    }
    
    return ip;
  } catch (e) {
    if (verbose) console.log(`⚠️  Error resolving IP for ${hostname}: ${e}`);
    return null;
  }
}


async function verifyDevice(ip: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:1400/xml/device_description.xml`, {
      signal: AbortSignal.timeout(1000),
    });
    const text = await res.text();
    return text.includes("Sonos") || text.includes("ZonePlayer");
  } catch {
    return false;
  }
}

function isHostUnreachable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /No route to host|os error 65|EHOSTUNREACH|Failed to connect/i.test(msg);
}

function unreachableHint(ip?: string): string {
  const where = ip ? ` at ${ip}:1400` : "";
  return `Cannot reach Sonos${where} (macOS blocked LAN). Run ./sonos-cli from Terminal.app (not Cursor), click Allow on Local Network. Or System Settings → Privacy & Security → Local Network → enable Cursor.`;
}

async function pickReachableIp(preferred?: string): Promise<{ ip: string; fallback: boolean } | null> {
  const candidates: string[] = [];
  for (const ip of [preferred, ...config.devices.map((d) => d.ip)]) {
    if (ip && !candidates.includes(ip)) candidates.push(ip);
  }
  for (const ip of candidates) {
    if (await verifyDevice(ip)) return { ip, fallback: ip !== preferred };
  }
  return null;
}

async function fetchDeviceInfo(ip: string): Promise<SonosDevice> {
  const device: SonosDevice = {
    ip,
    name: "Unknown Sonos",
    model: "Unknown",
    room: "Unknown Room",
    lastSeen: new Date().toISOString(),
  };

  try {
    const res = await fetch(`http://${ip}:1400/xml/device_description.xml`, {
      signal: AbortSignal.timeout(2000),
    });
    
    if (res.ok) {
      const xml = await res.text();
      
      const roomMatch = xml.match(/<roomName>(.*?)<\/roomName>/i);
      const modelMatch = xml.match(/<modelName>(.*?)<\/modelName>/i);
      const displayMatch = xml.match(/<displayName>(.*?)<\/displayName>/i);
      const uuidMatch = xml.match(/<UDN>uuid:(.*?)<\/UDN>/i);
      
      device.room = roomMatch?.[1] || device.room;
      device.model = modelMatch?.[1] || device.model;
      device.name = displayMatch?.[1] || roomMatch?.[1] || device.name;
      device.uuid = uuidMatch?.[1];
    }
  } catch {
    console.error(`Failed to fetch device info for ${ip}`);
  }

  return device;
}

// ============= Sonos Control =============
async function setAVTransportURI(ip: string, uri: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "SetAVTransportURI", body);
}

async function setAVTransportURIWithMeta(ip: string, uri: string, metadata?: VideoMetadata): Promise<void> {
  const title = metadata?.title || "Stream";
  const artist = metadata?.uploader || metadata?.artist || "Unknown Artist";
  const duration = metadata?.duration;
  const durationStr = duration && duration > 0 ? secondsToHms(duration) : null;

  const protocolInfo = "http-get:*:audio/mpeg:DLNA.ORG_PN=MP3";

  const didl = `
<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"
           xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">
  <item id="0" parentID="0" restricted="false">
    <dc:title>${title}</dc:title>
    <dc:creator>${artist}</dc:creator>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res protocolInfo="${protocolInfo}"${durationStr ? ` duration="${durationStr}"` : ""}>${uri}</res>
  </item>
</DIDL-Lite>`.trim();

  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "SetAVTransportURI", body);
}

async function play(ip: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "Play", body);
}

async function pause(ip: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Pause>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "Pause", body);
}

async function stop(ip: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "Stop", body);
}

async function seek(ip: string, positionSeconds: number): Promise<void> {
  const hours = Math.floor(positionSeconds / 3600);
  const minutes = Math.floor((positionSeconds % 3600) / 60);
  const seconds = Math.floor(positionSeconds % 60);
  const time = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Unit>REL_TIME</Unit>
      <Target>${time}</Target>
    </u:Seek>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "Seek", body);
}

async function getPositionInfo(ip: string): Promise<{ position: number; duration: number } | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetPositionInfo>
  </s:Body>
</s:Envelope>`;

  try {
    const response = await fetch(`http://${ip}:1400/MediaRenderer/AVTransport/Control`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": `"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"`,
      },
      body,
    });

    if (!response.ok) return null;

    const text = await response.text();
    
    const relTimeMatch = text.match(/<RelTime>(.*?)<\/RelTime>/);
    const trackDurationMatch = text.match(/<TrackDuration>(.*?)<\/TrackDuration>/);
    
    if (!relTimeMatch || !trackDurationMatch) return null;
    
    const parseTime = (timeStr: string): number => {
      const parts = timeStr.split(":").map(Number);
      if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
      return 0;
    };
    
    return {
      position: parseTime(relTimeMatch[1]),
      duration: parseTime(trackDurationMatch[1]),
    };
  } catch {
    return null;
  }
}

async function addURIToQueue(ip: string, uri: string, metadata: string = ""): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddURIToQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <EnqueuedURI>${escapeXml(uri)}</EnqueuedURI>
      <EnqueuedURIMetaData>${escapeXml(metadata)}</EnqueuedURIMetaData>
      <DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>
      <EnqueueAsNext>1</EnqueueAsNext>
    </u:AddURIToQueue>
  </s:Body>
</s:Envelope>`;

  await soap(ip, "/MediaRenderer/AVTransport/Control", "AVTransport", "AddURIToQueue", body);
}

async function killChild(proc?: Deno.ChildProcess): Promise<void> {
  if (!proc) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
  try {
    await proc.status;
  } catch {
    // ignore
  }
}

function ytdlpStreamArgs(ytUrl: string): string[] {
  // android avoids SABR/403 on default+tv clients (yt-dlp 2025.12 still works this way)
  return [
    "--no-update",
    "--no-playlist",
    "-f", "bestaudio/best",
    "--extractor-args", "youtube:player_client=android",
    "-o", "-",
    ytUrl,
  ];
}

function isToolFatal(line: string): boolean {
  const t = line.trim();
  return /^ERROR:/i.test(t) || /Error opening input/i.test(t) || /unable to download video data/i.test(t);
}

async function logProcessStderr(
  name: string,
  stream: ReadableStream<Uint8Array> | null,
  onFatal?: (msg: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        await log(`${name}: ${t}`);
        if (onFatal && isToolFatal(t)) onFatal(t.replace(/^ERROR:\s*/i, ""));
      }
    }
  } catch {
    // ignore
  }
}

async function soap(ip: string, path: string, service: string, action: string, xml: string) {
  const url = `http://${ip}:1400${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
      },
      body: xml,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`SOAP ${action} failed: ${res.status} ${res.statusText}\n${txt}`);
    }
  } catch (e) {
    if (isHostUnreachable(e)) throw new Error(unreachableHint(ip));
    throw e;
  }
}

// ============= File Caching for Seek Support =============
async function startBackgroundDownload(ytUrl: string): Promise<void> {
  if (playbackState.downloadInProgress || playbackState.cachedFilePath) {
    return;
  }

  playbackState.downloadInProgress = true;

  await ensureDir(CACHE_DIR);

  const urlHash = await hashString(ytUrl);
  const cacheFile = join(CACHE_DIR, `${urlHash}.mp3`);

  try {
    const stat = await Deno.stat(cacheFile);
    if (stat.isFile) {
      playbackState.cachedFilePath = cacheFile;
      playbackState.downloadInProgress = false;
      return;
    }
  } catch {
    console.error(`File ${cacheFile} does not exist`);
  }

  (async () => {
    const ytdlpPath = await findCommandPath("yt-dlp");
    const ffmpegPath = await findCommandPath("ffmpeg");

    const ytdlp = new Deno.Command(ytdlpPath, {
      args: ytdlpStreamArgs(ytUrl),
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const ffmpeg = new Deno.Command(ffmpegPath, {
      args: [
        "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-f", "mp3",
        "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        "-y",
        cacheFile
      ],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();

    playbackState.activeProcesses = playbackState.activeProcesses || {};
    playbackState.activeProcesses.downloader = ytdlp;

    ytdlp.stdout!.pipeTo(ffmpeg.stdin!).catch(() => {});

    const ffmpegStatus = await ffmpeg.status;
    const ytdlpStatus = await ytdlp.status;

    if (ffmpegStatus.success && ytdlpStatus.success) {
      try {
        const stat = await Deno.stat(cacheFile);
        if (stat.isFile && stat.size > 0) {
          playbackState.cachedFilePath = cacheFile;
          if (!tuiEnabled) {
            console.log(`💾 File cached for seek support: ${cacheFile}`);
          }
        }
      } catch {
        console.error(`Failed to create file ${cacheFile}`);
      }
    }

    playbackState.downloadInProgress = false;
    playbackState.activeProcesses = playbackState.activeProcesses || {};
    delete playbackState.activeProcesses.downloader;
  })().catch(() => {
    playbackState.downloadInProgress = false;
  });
}

async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

// ============= Stream Handlers =============
async function handleFileStream(req: Request, filePath: string): Promise<Response> {
  let fileStat;
  try {
    fileStat = await Deno.stat(filePath);
  } catch {
    return new Response("File not found", { status: 404 });
  }

  const fileSize = fileStat.size;
  const rangeHeader = req.headers.get("range");

  const file = await Deno.open(filePath, { read: true });

  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      await file.seek(start, Deno.SeekMode.Start);

      const buffer = new Uint8Array(chunkSize);
      await file.read(buffer);

      file.close();

      return new Response(buffer, {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize.toString(),
        },
      });
    }
  }

  return new Response(file.readable, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": fileSize.toString(),
      "Accept-Ranges": "bytes",
    },
  });
}

async function startEncoder(ytUrl: string): Promise<void> {
  const ytdlpPath = await findCommandPath("yt-dlp");
  const ffmpegPath = await findCommandPath("ffmpeg");

  const ytdlp = new Deno.Command(ytdlpPath, {
    args: ytdlpStreamArgs(ytUrl),
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const ffmpeg = new Deno.Command(ffmpegPath, {
    args: [
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-f", "mp3",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-bufsize", "64k",
      "pipe:1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  playbackState.activeProcesses = playbackState.activeProcesses || {};
  playbackState.activeProcesses.ytdlp = ytdlp;
  playbackState.activeProcesses.ffmpeg = ffmpeg;
  playbackState.streamListeners = new Set();
  playbackState.streamPreroll = [];
  playbackState.streamActive = true;

  let rejectReady: (e: Error) => void = () => {};
  const failed = new Promise<void>((_, reject) => {
    rejectReady = reject;
  });
  const onFatal = (msg: string) => rejectReady(new Error(msg));

  logProcessStderr("YTDLP", ytdlp.stderr, onFatal);
  logProcessStderr("FFMPEG", ffmpeg.stderr, onFatal);
  ytdlp.stdout!.pipeTo(ffmpeg.stdin!).catch(() => {});

  let prerollBytes = 0;
  let gotFirst = false;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const reader = ffmpeg.stdout!.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!gotFirst) {
          gotFirst = true;
          resolveReady();
        }
        if (prerollBytes < 64 * 1024) {
          playbackState.streamPreroll?.push(value);
          prerollBytes += value.byteLength;
        }
        for (const listener of playbackState.streamListeners ?? []) {
          try {
            listener(value);
          } catch {
            playbackState.streamListeners?.delete(listener);
          }
        }
      }
    } catch (e) {
      await log(`STREAM: encoder read error - ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      playbackState.streamActive = false;
    }
  })();

  let timer: number | undefined;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error("yt-dlp/ffmpeg produced no audio in 25s")), 25000);
  });

  try {
    await Promise.race([ready, timeout, failed]);
  } catch (e) {
    await killChild(ffmpeg);
    await killChild(ytdlp);
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await log("STREAM: encoder produced audio");
}

function handleLiveStream(_req: Request): Response {
  let listener: ((chunk: Uint8Array) => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const set = playbackState.streamListeners;
      if (playbackState.streamPreroll) {
        for (const chunk of playbackState.streamPreroll) {
          try {
            controller.enqueue(chunk);
          } catch {
            return;
          }
        }
      }
      listener = (chunk) => {
        try {
          controller.enqueue(chunk);
        } catch {
          if (listener) set?.delete(listener);
        }
      };
      set?.add(listener);
    },
    cancel() {
      if (listener) playbackState.streamListeners?.delete(listener);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "icy-name": playbackState.currentMetadata?.title || "YouTube",
    },
  });
}

// ============= Streaming Server =============
async function startStreamingServer(ytUrl: string, deviceIp: string): Promise<void> {
  await log(`STREAM: Starting server for ${ytUrl}`);
  await stopCurrentStream();

  const localIp = getLocalIPv4();
  if (!localIp) {
    throw new Error("Cannot determine local IP address");
  }

  const port = config.httpPort || (await chooseAvailablePort(17800, 18000));
  config.httpPort = port;
  await saveConfig();

  playbackState.serverController = new AbortController();
  playbackState.currentUrl = ytUrl;
  playbackState.isPlaying = true;
  playbackState.useFileStream = false;

  const server = Deno.serve(
    {
      hostname: "0.0.0.0",
      port,
      signal: playbackState.serverController.signal,
      onListen: () => {},
    },
    async (req) => {
      const url = new URL(req.url);
      await log(`STREAM: ${req.method} ${url.pathname} ua=${req.headers.get("user-agent") || "?"}`);
      if (url.pathname !== STREAM_PATH && url.pathname !== STREAM_FILE_PATH) {
        return new Response("Not found", { status: 404 });
      }

      const useFile = playbackState.useFileStream && playbackState.cachedFilePath;
      if (useFile) {
        return await handleFileStream(req, playbackState.cachedFilePath!);
      }
      return handleLiveStream(req);
    },
  );

  playbackState.server = server;

  addTUIMessage("⏳ Fetching YouTube audio...");
  if (tuiEnabled) renderTUI();
  await startEncoder(ytUrl);

  const rinconUri = `x-rincon-mp3radio://${localIp}:${port}${STREAM_PATH}`;

  await log(`STREAM: Setting URI - rinconUri=${rinconUri}, deviceIp=${deviceIp}`);
  await setAVTransportURI(deviceIp, rinconUri);
  await log(`STREAM: URI set successfully`);

  await log(`STREAM: Sending play command to device`);
  await play(deviceIp);
  await log(`STREAM: Play command sent`);

  const transport = await getTransportInfo(deviceIp).catch(() => null);
  await log(`STREAM: transport state=${transport?.state || "unknown"}`);

  if (!tuiEnabled) {
    console.log(`✅ Playing on ${deviceIp}`);
    console.log(`📻 Stream URL: http://${localIp}:${port}${STREAM_PATH}`);
  }
}

async function startQueueStreamingServer(ytUrl: string): Promise<string> {
  const localIp = getLocalIPv4();
  if (!localIp) {
    throw new Error("Cannot determine local IP address");
  }

  const port = await chooseAvailablePort(17800, 18000);
  if (port === 0) {
    throw new Error("No available port for queue stream");
  }

  const serverController = new AbortController();

  const server = Deno.serve(
    { 
      hostname: "0.0.0.0", 
      port, 
      signal: serverController.signal,
      onListen: () => {}
    },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== STREAM_PATH && url.pathname !== STREAM_FILE_PATH) {
        return new Response("Not found", { status: 404 });
      }

      const ytdlpPath = await findCommandPath("yt-dlp");
      const ffmpegPath = await findCommandPath("ffmpeg");

      const ytdlp = new Deno.Command(ytdlpPath, {
        args: ytdlpStreamArgs(ytUrl),
        stdout: "piped",
        stderr: "null",
      }).spawn();

      const ffmpeg = new Deno.Command(ffmpegPath, {
        args: [
          "-loglevel", "error",
          "-i", "pipe:0",
          "-vn",
          "-f", "mp3",
          "-b:a", "192k",
          "-ar", "44100",
          "-ac", "2",
          "pipe:1"
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();

      ytdlp.stdout!.pipeTo(ffmpeg.stdin!).catch(() => {});

      let controllerClosed = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      
      const cleanup = async () => {
        if (reader) {
          try {
            await reader.cancel();
          } catch {
              console.error(`Failed to cancel reader: ${e}`);
          }
          try {
            reader.releaseLock();
          } catch {
              console.error(`Failed to release reader lock: ${e}`);
          }
        }

        const killProcess = async (proc: Deno.ChildProcess | undefined) => {
          await killChild(proc);
        };

        await Promise.all([
          killProcess(ffmpeg),
          killProcess(ytdlp),
        ]);
      };

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          reader = ffmpeg.stdout!.getReader();
          (async () => {
            try {
              while (true) {
                const { value, done } = await reader!.read();
                if (done) break;
                if (value && !controllerClosed) {
                  try {
                    controller.enqueue(value);
                  } catch {
                    break;
                  }
                }
              }
            } catch {
              console.error(`Stream error: ${e}`);
            } finally {
              await cleanup();
              if (!controllerClosed) {
                try {
                  controller.close();
                } catch {
                  console.error(`Failed to close controller: ${e}`);
                }
                controllerClosed = true;
              }
            }
          })();
        },
        cancel() {
          controllerClosed = true;
          cleanup();
        },
      });

      return new Response(body, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Connection": "close",
          "Cache-Control": "no-store",
        },
      });
    },
  );

  server.catch(() => {
    console.error(`Server closed: ${e}`);
  });

  return `http://${localIp}:${port}${STREAM_PATH}`;
}

async function stopCurrentStream(): Promise<void> {
  stopPositionTracking();
  playbackState.streamListeners = new Set();
  playbackState.streamPreroll = [];

  if (playbackState.activeProcesses) {
    await Promise.all([
      killChild(playbackState.activeProcesses.ffmpeg),
      killChild(playbackState.activeProcesses.ytdlp),
      killChild(playbackState.activeProcesses.downloader),
    ]);
    playbackState.activeProcesses = {};
  }

  if (playbackState.serverController) {
    playbackState.serverController.abort();
    playbackState.serverController = undefined;
  }

  if (playbackState.server) {
    try {
      await playbackState.server.shutdown();
    } catch {
      // already stopped
    }
    playbackState.server = undefined;
  }

  playbackState.isPlaying = false;
  playbackState.currentUrl = undefined;
  playbackState.currentMetadata = undefined;
  playbackState.streamActive = false;
  playbackState.useFileStream = false;
  playbackState.downloadInProgress = false;
  
  if (tuiEnabled) {
    renderTUI();
  }
}

// ============= CLI Commands =============
async function cmdScan(args: string[]): Promise<void> {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const timeout = parseInt(args.find(a => a.startsWith("--timeout="))?.split("=")[1] || "5000");
  
  addTUIMessage("🔍 Scanning for Sonos devices...");
  const devices = await discoverSonosDevices(timeout, verbose);
  
  if (devices.length === 0) {
    addTUIMessage("❌ No Sonos devices found");
    addTUIMessage("💡 Tips: Make sure Sonos is on, same network, try: scan --verbose --timeout=10000");
    return;
  }

  config.devices = devices;
  config.lastScan = new Date().toISOString();

  if (config.defaultDevice && !devices.some((d) => d.ip === config.defaultDevice)) {
    const prev = config.defaultDevice;
    config.defaultDevice = devices.length === 1 ? devices[0].ip : undefined;
    addTUIMessage(
      config.defaultDevice
        ? `⚠️  Default IP ${prev} is gone; now using ${config.defaultDevice}`
        : `⚠️  Default IP ${prev} is gone; run 'set-default <n>'`,
    );
  }

  await saveConfig();

  addTUIMessage(`✅ Found ${devices.length} device(s)`);
  devices.forEach((d, i) => {
    const isDefault = d.ip === config.defaultDevice ? " [DEFAULT]" : "";
    addTUIMessage(`${i + 1}. ${d.name}${isDefault} - ${d.room} (${d.ip})`);
  });

  if (devices.every((d) => d.model === "Unknown")) {
    addTUIMessage(`⚠️  ${unreachableHint()}`);
  }
  
  if (tuiEnabled) renderTUI();
}

async function cmdList(): Promise<void> {
  // The list view will be rendered by renderDevicesView()
  // No need to add messages here
}

async function cmdPlay(args: string[]): Promise<void> {
  await log(`PLAY: Called with args=${JSON.stringify(args)}`);
  
  const url = args.find(a => a.startsWith("http"));
  if (!url) {
    await log(`PLAY: No URL provided`);
    addTUIMessage("❌ Please provide a YouTube URL");
    addTUIMessage("Usage: play <YouTube-URL> [device-index|ip]");
    return;
  }

  await log(`PLAY: URL=${url}`);
  
  let targetIp: string | undefined;
  
  const deviceArg = args.find(a => !a.startsWith("http"));
  if (deviceArg) {
    const index = parseInt(deviceArg);
    if (!isNaN(index) && index > 0 && index <= config.devices.length) {
      targetIp = config.devices[index - 1].ip;
      await log(`PLAY: Device specified by index=${index}, ip=${targetIp}`);
    } else if (deviceArg.includes(".")) {
      targetIp = deviceArg;
      await log(`PLAY: Device specified by IP=${targetIp}`);
    }
  }

  if (!targetIp) {
    targetIp = config.defaultDevice;
    await log(`PLAY: Using default device=${targetIp}`);
  }

  if (!targetIp) {
    await log(`PLAY: No device available, aborting`);
    addTUIMessage("❌ No device specified and no default set");
    addTUIMessage("Run 'scan' first, then 'set-default <number>' or specify device");
    return;
  }

  const reachable = await pickReachableIp(targetIp);
  if (!reachable) {
    await log(`PLAY: Device unreachable target=${targetIp}`);
    addTUIMessage(`❌ ${unreachableHint(targetIp)}`);
    return;
  }
  if (reachable.fallback) {
    await log(`PLAY: Fallback ${targetIp} → ${reachable.ip}`);
    addTUIMessage(`⚠️  ${targetIp} unreachable, using ${reachable.ip}`);
    if (config.defaultDevice === targetIp) {
      config.defaultDevice = reachable.ip;
      await saveConfig();
    }
    targetIp = reachable.ip;
  }

  if (!await checkDependencies()) {
    await log(`PLAY: Missing dependencies, aborting`);
    addTUIMessage("❌ Missing dependencies. Check installation.");
    return;
  }

  const device = config.devices.find(d => d.ip === targetIp) || {
    ip: targetIp,
    name: targetIp,
    model: "Unknown",
    room: "Unknown",
    lastSeen: new Date().toISOString(),
  };
  
  playbackState.currentDevice = device;
  await log(`PLAY: Starting playback on device=${device.name} (${device.ip})`);
  addTUIMessage(`🎵 Starting playback on ${device.name}...`);
  if (tuiEnabled) renderTUI();
  
  const metadataPromise = fetchVideoMetadata(url);
  
  try {
    await log(`PLAY: Starting streaming server`);
    await startStreamingServer(url, targetIp);
    await log(`PLAY: Streaming server started`);
    
    const metadata = await metadataPromise;
    if (metadata) {
      playbackState.currentMetadata = metadata;
      await log(`PLAY: Metadata received - title=${metadata.title}, duration=${metadata.duration}s`);
      addTUIMessage(`✅ Now playing: ${metadata.title}`);
      if (tuiEnabled) renderTUI();
    } else {
      await log(`PLAY: WARNING - No metadata received`);
      addTUIMessage("✅ Playback started");
      if (tuiEnabled) renderTUI();
    }
    
    playbackState.isPaused = false;
    startPositionTracking(targetIp);
    await log(`PLAY: Position tracking started, isPaused=false`);
  } catch (e) {
    await log(`PLAY: ERROR - ${e instanceof Error ? e.message : String(e)}`);
    await log(`PLAY: Stack trace - ${e instanceof Error ? e.stack : 'N/A'}`);
    addTUIMessage(`❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    playbackState.currentMetadata = undefined;
    playbackState.currentDevice = undefined;
    if (tuiEnabled) renderTUI();
  }
}

async function cmdNext(args: string[]): Promise<void> {
  if (args.length < 1) {
    addTUIMessage("❌ Please provide a YouTube URL or music library entry");
    addTUIMessage("Usage: next <URL|index|name> [device-index|ip]");
    addTUIMessage("Example: next https://youtu.be/...");
    addTUIMessage("Example: next 1  (queue track 1 from music library)");
    return;
  }

  let url: string | undefined;
  let targetIp: string | undefined;

  const urlArg = args.find(a => a.startsWith("http"));
  if (urlArg) {
    url = urlArg;
    const deviceArg = args.find(a => !a.startsWith("http"));
    if (deviceArg) {
      const index = parseInt(deviceArg);
      if (!isNaN(index) && index > 0 && index <= config.devices.length) {
        targetIp = config.devices[index - 1].ip;
      } else if (deviceArg.includes(".")) {
        targetIp = deviceArg;
      }
    }
  } else {
    const identifier = args[0];
    let musicIndex = -1;
    const index = parseInt(identifier);
    if (!isNaN(index) && index > 0 && index <= config.musicCatalog.length) {
      musicIndex = index - 1;
    } else {
      musicIndex = config.musicCatalog.findIndex(m => m.name.toLowerCase() === identifier.toLowerCase());
    }
    
    if (musicIndex === -1) {
      addTUIMessage(`❌ Music not found: ${identifier}`);
      addTUIMessage("Usage: next <URL|index|name> [device-index|ip]");
      return;
    }
    
    url = config.musicCatalog[musicIndex].url;
    
    if (args.length > 1) {
      const deviceArg = args[1];
      const deviceIndex = parseInt(deviceArg);
      if (!isNaN(deviceIndex) && deviceIndex > 0 && deviceIndex <= config.devices.length) {
        targetIp = config.devices[deviceIndex - 1].ip;
      } else if (deviceArg.includes(".")) {
        targetIp = deviceArg;
      }
    }
  }

  if (!targetIp) {
    targetIp = config.defaultDevice;
  }

  if (!targetIp) {
    addTUIMessage("❌ No device specified and no default set");
    addTUIMessage("Run 'scan' first, then 'set-default <number>' or specify device");
    return;
  }

  const reachable = await pickReachableIp(targetIp);
  if (!reachable) {
    addTUIMessage(`❌ ${unreachableHint(targetIp)}`);
    return;
  }
  if (reachable.fallback) {
    addTUIMessage(`⚠️  ${targetIp} unreachable, using ${reachable.ip}`);
    if (config.defaultDevice === targetIp) {
      config.defaultDevice = reachable.ip;
      await saveConfig();
    }
    targetIp = reachable.ip;
  }

  if (!await checkDependencies()) {
    addTUIMessage("❌ Missing dependencies. Check installation.");
    return;
  }

  const device = config.devices.find(d => d.ip === targetIp) || {
    ip: targetIp,
    name: targetIp,
    model: "Unknown",
    room: "Unknown",
    lastSeen: new Date().toISOString(),
  };

  addTUIMessage(`📥 Queuing song on ${device.name}...`);
  if (tuiEnabled) renderTUI();

  const metadataPromise = fetchVideoMetadata(url);

  try {
    const streamUrl = await startQueueStreamingServer(url);
    await setAVTransportURI(targetIp, streamUrl);
    
    await addURIToQueue(targetIp, streamUrl);

    const metadata = await metadataPromise;
    if (metadata) {
      addTUIMessage(`✅ Queued: ${metadata.title}`);
    } else {
      addTUIMessage("✅ Song queued");
    }
    if (tuiEnabled) renderTUI();
  } catch (e) {
    addTUIMessage(`❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    if (tuiEnabled) renderTUI();
  }
}

function startPositionTracking(deviceIp: string): void {
  if (playbackState.positionUpdateInterval !== undefined) {
    clearInterval(playbackState.positionUpdateInterval);
  }
  
  playbackState.positionUpdateInterval = setInterval(async () => {
    if (playbackState.isPlaying && !playbackState.isPaused && playbackState.currentDevice) {
      const posInfo = await getPositionInfo(deviceIp);
      if (posInfo) {
        const oldPosition = playbackState.lastPosition;
        playbackState.lastPosition = posInfo.position;
        if (!playbackState.lastPositionLogTime || Date.now() - playbackState.lastPositionLogTime > 10000) {
          await log(`POSITION: Updated - ${posInfo.position}s (${formatDuration(posInfo.position)}) / ${posInfo.duration}s (${formatDuration(posInfo.duration)}), was=${oldPosition || 'none'}`);
          playbackState.lastPositionLogTime = Date.now();
        }
        if (tuiEnabled) renderTUI();
      }
    }
  }, 2000) as unknown as number;
}

function stopPositionTracking(): void {
  if (playbackState.positionUpdateInterval !== undefined) {
    clearInterval(playbackState.positionUpdateInterval);
    playbackState.positionUpdateInterval = undefined;
  }
}

async function cmdPause(): Promise<void> {
  await log(`PAUSE: Called - isPlaying=${playbackState.isPlaying}, isPaused=${playbackState.isPaused}, hasDevice=${!!playbackState.currentDevice}`);
  
  if (!playbackState.isPlaying || !playbackState.currentDevice) {
    await log(`PAUSE: Nothing playing, aborting`);
    addTUIMessage("❌ Nothing is currently playing");
    if (tuiEnabled) renderTUI();
    return;
  }

  if (playbackState.isPaused) {
    await log(`PAUSE: Already paused, aborting`);
    addTUIMessage("⏸️  Already paused");
    if (tuiEnabled) renderTUI();
    return;
  }

  try {
    await log(`PAUSE: Getting position info from device ${playbackState.currentDevice.ip}`);
    const posInfo = await getPositionInfo(playbackState.currentDevice.ip);
    if (posInfo) {
      playbackState.lastPosition = posInfo.position;
      await log(`PAUSE: Position saved - ${posInfo.position}s (${formatDuration(posInfo.position)})`);
    } else {
      await log(`PAUSE: WARNING - Could not get position info, using lastPosition=${playbackState.lastPosition}`);
    }
    
    await log(`PAUSE: State before pause - lastPosition=${playbackState.lastPosition}, useFileStream=${playbackState.useFileStream}, cachedFilePath=${playbackState.cachedFilePath || 'none'}`);
    
    await log(`PAUSE: Sending pause command to Sonos`);
    await pause(playbackState.currentDevice.ip);

    if (playbackState.activeProcesses) {
      await log(`PAUSE: Stopping live stream processes - hasFFmpeg=${!!playbackState.activeProcesses.ffmpeg}, hasYtdlp=${!!playbackState.activeProcesses.ytdlp}`);
      await Promise.all([
        killChild(playbackState.activeProcesses.ffmpeg),
        killChild(playbackState.activeProcesses.ytdlp),
      ]);

      delete playbackState.activeProcesses.ffmpeg;
      delete playbackState.activeProcesses.ytdlp;
      playbackState.streamActive = false;
      await log(`PAUSE: Live stream processes stopped`);
    } else {
      await log(`PAUSE: No active processes to stop`);
    }
    
    playbackState.isPaused = true;
    await log(`PAUSE: Success - isPaused=true, lastPosition=${playbackState.lastPosition}`);
    addTUIMessage("⏸️  Playback paused");
    if (tuiEnabled) renderTUI();
  } catch (e) {
    await log(`PAUSE: ERROR - ${e instanceof Error ? e.message : String(e)}`);
    addTUIMessage(`❌ Error pausing: ${e instanceof Error ? e.message : String(e)}`);
    if (tuiEnabled) renderTUI();
  }
}

async function getTransportInfo(ip: string): Promise<{ state: string; position: number } | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetTransportInfo>
  </s:Body>
</s:Envelope>`;

  try {
    const response = await fetch(`http://${ip}:1400/MediaRenderer/AVTransport/Control`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": `"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"`,
      },
      body,
    });

    if (!response.ok) return null;

    const text = await response.text();
    
    const stateMatch = text.match(/<CurrentTransportState>(.*?)<\/CurrentTransportState>/);
    const state = stateMatch ? stateMatch[1] : null;
    
    const posInfo = await getPositionInfo(ip);
    
    return {
      state: state || "UNKNOWN",
      position: posInfo?.position || 0,
    };
  } catch {
    return null;
  }
}

async function cmdResume(): Promise<void> {
  await log(`RESUME: Called - hasDevice=${!!playbackState.currentDevice}, hasUrl=${!!playbackState.currentUrl}, isPaused=${playbackState.isPaused}`);
  
  if (!playbackState.currentDevice || !playbackState.currentUrl) {
    await log(`RESUME: No active session, aborting`);
    addTUIMessage("❌ No active playback session");
    if (tuiEnabled) renderTUI();
    return;
  }

  try {
    await log(`RESUME: Getting transport info from device ${playbackState.currentDevice.ip}`);
    const transportInfo = await getTransportInfo(playbackState.currentDevice.ip);
    await log(`RESUME: Transport info - state=${transportInfo?.state || 'null'}, position=${transportInfo?.position || 0}`);
    
    let resumePosition = 0;
    if (transportInfo) {
      if (transportInfo.state === "PLAYING") {
        await log(`RESUME: Already playing, aborting`);
        addTUIMessage("▶️  Already playing");
        playbackState.isPaused = false;
        playbackState.isPlaying = true;
        if (tuiEnabled) renderTUI();
        return;
      }
      
      resumePosition = transportInfo.position > 0 
        ? transportInfo.position 
        : (playbackState.lastPosition || 0);
      await log(`RESUME: Resume position from transportInfo - ${resumePosition}s`);
    } else if (playbackState.lastPosition !== undefined && playbackState.lastPosition > 0) {
      resumePosition = playbackState.lastPosition;
      await log(`RESUME: Using lastPosition fallback - ${resumePosition}s`);
    } else {
      await log(`RESUME: WARNING - No position available, will start from beginning`);
    }
    
    await log(`RESUME: State check - lastPosition=${playbackState.lastPosition}, useFileStream=${playbackState.useFileStream}, cachedFilePath=${playbackState.cachedFilePath || 'none'}`);
    
    const hasCachedFile = playbackState.cachedFilePath && 
      await Deno.stat(playbackState.cachedFilePath).then(() => true).catch(() => false);
    await log(`RESUME: Cached file check - hasCachedFile=${hasCachedFile}, resumePosition=${resumePosition}`);
    
    if (hasCachedFile && resumePosition > 0) {
      await log(`RESUME: Using file-based streaming with seek support`);
      playbackState.useFileStream = true;
      
      await log(`RESUME: Stopping old server`);
      if (playbackState.serverController) {
        playbackState.serverController.abort();
        playbackState.serverController = undefined;
      }
      
      if (playbackState.server) {
        try {
          await playbackState.server;
          await log(`RESUME: Old server closed`);
        } catch {
          await log(`RESUME: Old server already closed`);
        }
        playbackState.server = undefined;
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const localIp = getLocalIPv4();
      if (!localIp) {
        throw new Error("Cannot determine local IP address");
      }

      const port = await chooseAvailablePort(17800, 18000);
      if (port === 0) {
        throw new Error("No available port for stream");
      }
      await log(`RESUME: Starting new server on port ${port}`);
      config.httpPort = port;
      await saveConfig();

      playbackState.serverController = new AbortController();

      const server = Deno.serve(
        { 
          hostname: "0.0.0.0", 
          port, 
          signal: playbackState.serverController.signal,
          onListen: () => {}
        },
        async (req) => {
          const url = new URL(req.url);
          if (url.pathname !== STREAM_PATH && url.pathname !== STREAM_FILE_PATH) {
            return new Response("Not found", { status: 404 });
          }
          return await handleFileStream(req, playbackState.cachedFilePath!);
        },
      );

      playbackState.server = server;
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const baseUrl = `http://${localIp}:${port}`;
      const streamUrl = `${baseUrl}${STREAM_PATH}`;
      const streamFileUrl = `${baseUrl}${STREAM_FILE_PATH}`;
      await log(`RESUME: Stream URLs - streamUrl=${streamUrl}, streamFileUrl=${streamFileUrl}`);
      
      try {
        await log(`RESUME: Attempting setAVTransportURIWithMeta with streamFileUrl`);
        await setAVTransportURIWithMeta(playbackState.currentDevice.ip, streamFileUrl, playbackState.currentMetadata || undefined);
        await log(`RESUME: setAVTransportURIWithMeta succeeded`);
      } catch (e) {
        await log(`RESUME: setAVTransportURIWithMeta failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!tuiEnabled) {
          console.error("SetAVTransportURIWithMeta failed, falling back to plain HTTP:", e);
        }
        try {
          await log(`RESUME: Attempting setAVTransportURI (plain HTTP)`);
          await setAVTransportURI(playbackState.currentDevice.ip, streamFileUrl);
          await log(`RESUME: setAVTransportURI (plain HTTP) succeeded`);
        } catch (e2) {
          await log(`RESUME: setAVTransportURI (plain HTTP) failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          if (!tuiEnabled) {
            console.error("SetAVTransportURI (HTTP) failed, falling back to radio URI:", e2);
          }
          const rinconUri = `x-rincon-mp3radio://${streamUrl}`;
          await log(`RESUME: Using fallback radio URI: ${rinconUri}`);
          await setAVTransportURI(playbackState.currentDevice.ip, rinconUri);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      await log(`RESUME: Sending play command`);
      await play(playbackState.currentDevice.ip);
      
      await new Promise(resolve => setTimeout(resolve, 800));
      
      await log(`RESUME: Seeking to position ${resumePosition}s (${formatDuration(resumePosition)})`);
      await seek(playbackState.currentDevice.ip, resumePosition);
      playbackState.lastPosition = resumePosition;
      await log(`RESUME: Seek completed, lastPosition=${playbackState.lastPosition}`);
      
      addTUIMessage(`▶️  Resuming from ${formatDuration(resumePosition)} (seekable)`);
    } else {
      await log(`RESUME: Using live streaming fallback - hasCachedFile=${hasCachedFile}, resumePosition=${resumePosition}`);
      playbackState.useFileStream = false;
      
      if (playbackState.currentUrl) {
        await log(`RESUME: Starting live streaming server`);
        await startStreamingServer(playbackState.currentUrl, playbackState.currentDevice.ip);
        
        if (resumePosition > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            await log(`RESUME: Attempting seek on live stream to ${resumePosition}s`);
            const updatedTransportInfo = await getTransportInfo(playbackState.currentDevice.ip);
            if (updatedTransportInfo && 
                (updatedTransportInfo.state === "PLAYING" || updatedTransportInfo.state === "PAUSED_PLAYBACK")) {
              await seek(playbackState.currentDevice.ip, resumePosition);
              playbackState.lastPosition = resumePosition;
              await log(`RESUME: Seek on live stream succeeded`);
              addTUIMessage(`▶️  Resuming from ${formatDuration(resumePosition)}`);
            } else {
              await log(`RESUME: WARNING - Cannot seek, transport state=${updatedTransportInfo?.state}`);
              addTUIMessage("▶️  Playback resumed (from beginning)");
            }
          } catch (e) {
            await log(`RESUME: Seek on live stream failed: ${e instanceof Error ? e.message : String(e)}`);
            addTUIMessage("▶️  Playback resumed (from beginning)");
          }
        } else {
          await log(`RESUME: No resume position, starting from beginning`);
          addTUIMessage("▶️  Playback resumed");
        }
      }
    }
    
    playbackState.isPaused = false;
    playbackState.isPlaying = true;
    await log(`RESUME: State updated - isPaused=false, isPlaying=true`);
    
    if (playbackState.currentDevice) {
      startPositionTracking(playbackState.currentDevice.ip);
      await log(`RESUME: Position tracking restarted`);
    }
    
    await log(`RESUME: Success`);
    if (tuiEnabled) renderTUI();
  } catch (e) {
    await log(`RESUME: ERROR - ${e instanceof Error ? e.message : String(e)}`);
    await log(`RESUME: Stack trace - ${e instanceof Error ? e.stack : 'N/A'}`);
    addTUIMessage(`❌ Error resuming: ${e instanceof Error ? e.message : String(e)}`);
    if (tuiEnabled) renderTUI();
  }
}

async function cmdStop(): Promise<void> {
  if (!playbackState.isPlaying) {
    addTUIMessage("No active playback");
    return;
  }

  await stopCurrentStream();
  
  if (config.defaultDevice) {
    try {
      await stop(config.defaultDevice);
    } catch {}
  }
  
  addTUIMessage("⏹️  Playback stopped");
  if (tuiEnabled) renderTUI();
}

async function cmdSetDefault(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) {
    addTUIMessage("Usage: set-default <device-number|ip>");
    return;
  }

  const index = parseInt(arg);
  if (!isNaN(index) && index > 0 && index <= config.devices.length) {
    config.defaultDevice = config.devices[index - 1].ip;
    await saveConfig();
    addTUIMessage(`✅ Default device set to: ${config.devices[index - 1].name}`);
  } else if (arg.includes(".")) {
    config.defaultDevice = arg;
    await saveConfig();
    addTUIMessage(`✅ Default device set to IP: ${arg}`);
  } else {
    addTUIMessage("❌ Invalid device number or IP");
  }
  
  if (tuiEnabled) renderTUI();
}

async function cmdStatus(): Promise<void> {
  // The status view will be rendered by renderStatusView()
  // No need to add messages here
}

async function cmdAddSonos(args: string[]): Promise<void> {
  if (args.length < 2) {
    addTUIMessage("Usage: add-sonos <name> <ip>");
    addTUIMessage("Example: add-sonos Living Room 192.168.1.50");
    return;
  }

  const name = args[0];
  const ip = args[1];

  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) {
    addTUIMessage(`❌ Invalid IP address format: ${ip}`);
    return;
  }

  const existingByIp = config.devices.find(d => d.ip === ip);
  if (existingByIp) {
    addTUIMessage(`❌ IP ${ip} already exists as: ${existingByIp.name}`);
    return;
  }

  const existingByName = config.devices.find(d => d.name.toLowerCase() === name.toLowerCase());
  if (existingByName) {
    addTUIMessage(`❌ Name "${name}" already exists with IP: ${existingByName.ip}`);
    return;
  }

  const deviceInfo = await fetchDeviceInfo(ip);
  const newDevice: SonosDevice = {
    ip,
    name,
    room: deviceInfo.room !== "Unknown Room" ? deviceInfo.room : name,
    model: deviceInfo.model,
    lastSeen: new Date().toISOString(),
  };

  config.devices.push(newDevice);
  await saveConfig();

  addTUIMessage(`✅ Added device: ${name} (${ip})`);
  if (tuiEnabled) renderTUI();
}

async function cmdUpdateSonos(args: string[]): Promise<void> {
  if (args.length < 2) {
    addTUIMessage("Usage: edit <n> <name>        - Change name only");
    addTUIMessage("       edit <n> <ip>          - Change IP only");
    addTUIMessage("       edit <n> <name> <ip>   - Change both");
    addTUIMessage("Example: edit 1 \"Living Room\"");
    addTUIMessage("Example: edit 1 192.168.1.51");
    addTUIMessage("Example: edit 1 \"Living Room\" 192.168.1.51");
    return;
  }

  const identifier = args[0];
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  
  let newName: string | undefined;
  let newIp: string | undefined;
  
  if (args.length === 2) {
    const arg2 = args[1];
    if (ipRegex.test(arg2)) {
      newIp = arg2;
    } else {
      newName = arg2;
    }
  } else if (args.length >= 3) {
    newName = args[1];
    newIp = args[2];
    
    if (!ipRegex.test(newIp)) {
      addTUIMessage(`❌ Invalid IP address format: ${newIp}`);
      return;
    }
  }

  let deviceIndex = -1;
  const index = parseInt(identifier);
  if (!isNaN(index) && index > 0 && index <= config.devices.length) {
    deviceIndex = index - 1;
  } else {
    deviceIndex = config.devices.findIndex(d => d.name.toLowerCase() === identifier.toLowerCase());
  }

  if (deviceIndex === -1) {
    addTUIMessage(`❌ Device not found: ${identifier}`);
    return;
  }

  const oldDevice = config.devices[deviceIndex];
  const oldIp = oldDevice.ip;
  const oldName = oldDevice.name;

  const finalName = newName !== undefined ? newName : oldName;
  const finalIp = newIp !== undefined ? newIp : oldIp;

  if (newIp !== undefined) {
    if (!ipRegex.test(newIp)) {
      addTUIMessage(`❌ Invalid IP address format: ${newIp}`);
      return;
    }
    
    if (newIp !== oldIp) {
      const existingByIp = config.devices.find((d, i) => i !== deviceIndex && d.ip === newIp);
      if (existingByIp) {
        addTUIMessage(`❌ IP ${newIp} already exists as: ${existingByIp.name}`);
        return;
      }
    }
  }

  if (newName !== undefined && newName.toLowerCase() !== oldDevice.name.toLowerCase()) {
    const existingByName = config.devices.find((d, i) => i !== deviceIndex && d.name.toLowerCase() === newName.toLowerCase());
    if (existingByName) {
      addTUIMessage(`❌ Name "${newName}" already exists with IP: ${existingByName.ip}`);
      return;
    }
  }

  const updatedDevice: SonosDevice = {
    ...oldDevice,
    name: finalName,
    ip: finalIp,
    lastSeen: new Date().toISOString(),
  };

  if (newIp !== undefined && newIp !== oldIp) {
    const deviceInfo = await fetchDeviceInfo(newIp);
    if (deviceInfo.model !== "Unknown") {
      updatedDevice.model = deviceInfo.model;
    }
    if (deviceInfo.room !== "Unknown Room") {
      updatedDevice.room = deviceInfo.room;
    }
  }

  config.devices[deviceIndex] = updatedDevice;

  if (config.defaultDevice === oldIp && newIp !== undefined) {
    config.defaultDevice = newIp;
  }

  await saveConfig();

  const changes: string[] = [];
  if (newName !== undefined && newName !== oldName) {
    changes.push(`${oldName} → ${newName}`);
  }
  if (newIp !== undefined && newIp !== oldIp) {
    changes.push(`${oldIp} → ${newIp}`);
  }
  
  if (changes.length > 0) {
    addTUIMessage(`✅ Updated device: ${changes.join(", ")}`);
  } else {
    addTUIMessage(`✅ Device unchanged`);
  }
  
  if (tuiEnabled) renderTUI();
}

async function cmdDeleteSonos(args: string[]): Promise<void> {
  if (args.length < 1) {
    addTUIMessage("Usage: delete-sonos <index|name>");
    addTUIMessage("Example: delete-sonos 1");
    addTUIMessage("Example: delete-sonos \"Kitchen\"");
    return;
  }

  const identifier = args[0];

  let deviceIndex = -1;
  const index = parseInt(identifier);
  if (!isNaN(index) && index > 0 && index <= config.devices.length) {
    deviceIndex = index - 1;
  } else {
    deviceIndex = config.devices.findIndex(d => d.name.toLowerCase() === identifier.toLowerCase());
  }

  if (deviceIndex === -1) {
    addTUIMessage(`❌ Device not found: ${identifier}`);
    return;
  }

  const device = config.devices[deviceIndex];

  config.devices.splice(deviceIndex, 1);

  if (config.defaultDevice === device.ip) {
    config.defaultDevice = undefined;
  }

  await saveConfig();

  addTUIMessage(`✅ Deleted device: ${device.name} (${device.ip})`);
  if (tuiEnabled) renderTUI();
}

async function cmdAddMusic(args: string[]): Promise<void> {
  if (args.length < 1) {
    addTUIMessage("Usage: add <url>");
    addTUIMessage("Example: add https://youtu.be/...");
    return;
  }

  const input = args.join(" ").trim();
  
  let url = "";
  const httpIndex = input.indexOf("http://");
  const httpsIndex = input.indexOf("https://");
  
  if (httpsIndex !== -1) {
    url = input.substring(httpsIndex).trim();
  } else if (httpIndex !== -1) {
    url = input.substring(httpIndex).trim();
  } else {
    url = input;
  }
  
  url = url.split(/\s+/)[0];

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    addTUIMessage(`❌ Invalid URL: ${url}`);
    addTUIMessage("URL must start with http:// or https://");
    return;
  }

  const existingByUrl = config.musicCatalog.find(m => m.url === url);
  if (existingByUrl) {
    addTUIMessage(`❌ URL already exists as: ${existingByUrl.name}`);
    return;
  }

  addTUIMessage("📥 Fetching video metadata...");
  if (tuiEnabled) renderTUI();
  
  const metadata = await fetchVideoMetadata(url);
  if (!metadata) {
    addTUIMessage(`❌ Failed to fetch metadata for URL: ${url}`);
    return;
  }

  const name = metadata.title || url;

  const existingByName = config.musicCatalog.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (existingByName) {
    addTUIMessage(`❌ "${name}" already exists in catalog`);
    return;
  }

  const newEntry: MusicEntry = {
    name,
    url,
    title: metadata.title,
    artist: metadata.uploader,
    duration: metadata.duration,
    addedAt: new Date().toISOString(),
  };

  config.musicCatalog.push(newEntry);
  await saveConfig();

  addTUIMessage(`✅ Added to catalog: ${name}`);
  if (tuiEnabled) renderTUI();
}

async function cmdDeleteMusic(args: string[]): Promise<void> {
  if (args.length < 1) {
    addTUIMessage("Usage: delete <index|name>");
    addTUIMessage("Example: delete 1");
    addTUIMessage("Example: delete \"My Favorite Song\"");
    return;
  }

  const identifier = args[0];

  let musicIndex = -1;
  const index = parseInt(identifier);
  if (!isNaN(index) && index > 0 && index <= config.musicCatalog.length) {
    musicIndex = index - 1;
  } else {
    musicIndex = config.musicCatalog.findIndex(m => m.name.toLowerCase() === identifier.toLowerCase());
  }

  if (musicIndex === -1) {
    addTUIMessage(`❌ Music not found: ${identifier}`);
    return;
  }

  const music = config.musicCatalog[musicIndex];
  config.musicCatalog.splice(musicIndex, 1);
  await saveConfig();

  addTUIMessage(`✅ Deleted from catalog: ${music.name}`);
  if (tuiEnabled) renderTUI();
}

async function interactiveCLI(): Promise<void> {
  await initLogging();
  await log("Starting interactive CLI");
  
  await startTUI();
  addTUIMessage("Welcome! Type 'help' for commands.");

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let signalHandler: (() => void) | null = null;
  const setupSignalHandler = () => {
    if (signalHandler) return;
    
    signalHandler = () => {
      if (playbackState.isPlaying) {
        stopCurrentStream().then(() => {
          addTUIMessage("⏹️  Playback stopped (Ctrl+C)");
          if (tuiEnabled) renderTUI();
        }).catch((e) => {
          addTUIMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
          if (tuiEnabled) renderTUI();
        });
      } else {
        if (tuiEnabled) renderTUI();
      }
    };
    
    Deno.addSignalListener("SIGINT", signalHandler);
  };

  setupSignalHandler();

  let stdinReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let inputDecoder = new TextDecoder();
  let inputBuffer = "";
  
  const initStdinReader = () => {
    if (!stdinReader) {
      stdinReader = Deno.stdin.readable.getReader();
    }
  };
  
  initStdinReader();
  
  async function readLine(prompt: string = "sonos> ", promptX: number = 1, promptY: number = 23, lineWidth?: number): Promise<string | null> {
    if (!stdinReader) {
      initStdinReader();
    }
    
    inputBuffer = "";
    activePrompt = { prompt, x: promptX, y: promptY, width: lineWidth, input: "" };
    
    if (tuiEnabled) {
      updatePromptLine(prompt, "", promptX, promptY, lineWidth);
    }
    
    try {
      while (true) {
        if (!stdinReader) {
          initStdinReader();
          if (!stdinReader) {
            return null;
          }
        }
        
        const { done, value } = await stdinReader.read();
        
        if (done) {
          try {
            stdinReader.releaseLock();
          } catch {
            console.error(`Failed to release reader lock`);
          }
          stdinReader = null;
          initStdinReader();
          return null;
        }
        
        if (!value || value.length === 0) {
          continue;
        }
        
        for (let i = 0; i < value.length; i++) {
          const byte = value[i];
          
          if (byte === 0x7F || byte === 0x08) {
            if (inputBuffer.length > 0) {
              inputBuffer = inputBuffer.slice(0, -1);
              if (activePrompt) activePrompt.input = inputBuffer;
              if (tuiEnabled) {
                updatePromptLine(prompt, inputBuffer, promptX, promptY, lineWidth);
              }
            }
            continue;
          }
          
          if (byte === 0x0D || byte === 0x0A) {
            const line = inputBuffer.trim();
            inputBuffer = "";
            activePrompt = null;
            if (tuiEnabled) {
              moveCursor(promptY, promptX);
              const totalWidth = Math.max(0, (lineWidth ?? (TUI_WIDTH - promptX + 1)));
              const spaces = Math.max(0, totalWidth - prompt.length);
              Deno.stdout.writeSync(new TextEncoder().encode(prompt + " ".repeat(spaces)));
            }
            inputDecoder = new TextDecoder();
            return line;
          }
          
          if (byte < 0x20 && byte !== 0x09) {
            continue;
          }
          
          const char = String.fromCharCode(byte);
          inputBuffer += char;
          if (activePrompt) activePrompt.input = inputBuffer;
          
          if (tuiEnabled) {
            updatePromptLine(prompt, inputBuffer, promptX, promptY, lineWidth);
          }
        }
        
        if (inputBuffer.length > 10000) {
          inputBuffer = "";
          inputDecoder = new TextDecoder();
        }
      }
    } catch (e) {
      if (stdinReader) {
        try {
          stdinReader.releaseLock();
        } catch {
          console.error(`Failed to release reader lock:`);
        }
      }
      stdinReader = null;
      initStdinReader();
      inputDecoder = new TextDecoder();
      inputBuffer = "";
      return null;
    }
  }

  while (true) {
    if (tuiEnabled) renderTUI();
    
    const input = await readLine("sonos> ");
    if (input === null) break;
    
    if (!input) {
      if (tuiEnabled) renderTUI();
      continue;
    }

    const [cmd, ...args] = input.split(/\s+/);

    try {
      switch (cmd.toLowerCase()) {
        case "exit":
        case "quit":
        case "q":
          if (signalHandler) {
            Deno.removeSignalListener("SIGINT", signalHandler);
          }
          await log("Exiting application");
          stopTUI();
          await stopCurrentStream();
          await closeLogging();
          console.log("👋 Goodbye!");
          Deno.exit(0);
          break;

        case "help":
        case "h":
        case "?":
          helpContext = "main";
          currentModal = "help";
          if (tuiEnabled) renderTUI();
          while (true) {
            const input = await readLine("help> ", PROMPT_X, PROMPT_Y);
            if (input === null) break;
            const trimmed = input.trim().toLowerCase();
            if (!trimmed || trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
              break;
            }
            addTUIMessage("Type q or Enter to close help");
            if (tuiEnabled) renderTUI();
          }
          currentModal = null;
          if (tuiEnabled) renderTUI();
          break;

        case "scan":
          currentModal = null;
          await cmdScan(args);
          if (tuiEnabled) renderTUI();
          break;

        case "list":
        case "ls":
        case "devices":
        case "manage":
          currentModal = "devices";
          if (tuiEnabled) renderTUI();
          
          const deviceManagementLoop = async () => {
            while (currentModal === "devices") {
              if (tuiEnabled) renderTUI();
              const input = await readLine("devices> ", PROMPT_X, PROMPT_Y);
              if (input === null) break;
              
              if (!input) {
                if (tuiEnabled) renderTUI();
                continue;
              }

              const [cmd, ...cmdArgs] = input.split(/\s+/);

              try {
                switch (cmd.toLowerCase()) {
                  case "help":
                  case "h":
                  case "?":
                    helpContext = "music";
                    currentModal = "help";
                    if (tuiEnabled) renderTUI();
                    while (true) {
                      const hInput = await readLine("help> ", PROMPT_X, PROMPT_Y);
                      if (hInput === null) break;
                      const trimmed = hInput.trim().toLowerCase();
                      if (!trimmed || trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
                        break;
                      }
                      addTUIMessage("Type q or Enter to close help");
                      if (tuiEnabled) renderTUI();
                    }
                    currentModal = "music";
                    if (tuiEnabled) renderTUI();
                    break;
                  case "help":
                  case "h":
                  case "?":
                    helpContext = "devices";
                    currentModal = "help";
                    if (tuiEnabled) renderTUI();
                    while (true) {
                      const hInput = await readLine("help> ", PROMPT_X, PROMPT_Y);
                      if (hInput === null) break;
                      const trimmed = hInput.trim().toLowerCase();
                      if (!trimmed || trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
                        break;
                      }
                      addTUIMessage("Type q or Enter to close help");
                      if (tuiEnabled) renderTUI();
                    }
                    currentModal = "devices";
                    if (tuiEnabled) renderTUI();
                    break;
                  case "done":
                  case "exit":
                  case "close":
                  case "q":
                    currentModal = null;
                    if (tuiEnabled) renderTUI();
                    return;

                  case "add":
                    await cmdAddSonos(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "edit":
                  case "update":
                    await cmdUpdateSonos(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "delete":
                  case "remove":
                    await cmdDeleteSonos(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "set-default":
                  case "default":
                    await cmdSetDefault(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  default:
                    addTUIMessage(`Unknown command: ${cmd}. Use: add, edit, delete, set-default, or done`);
                    if (tuiEnabled) renderTUI();
                }
              } catch (e) {
                addTUIMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
                if (tuiEnabled) renderTUI();
              }
            }
          };
          
          await deviceManagementLoop();
          break;

        case "play":
        case "p":
          await cmdPlay(args);
          break;

        case "next":
        case "n":
          await cmdNext(args);
          break;

        case "stop":
        case "s":
          await cmdStop();
          break;

        case "pause":
          await cmdPause();
          break;

        case "resume":
        case "res":
          await cmdResume();
          break;

        case "set-default":
        case "default":
          await cmdSetDefault(args);
          break;

        case "status":
          currentModal = "status";
          await cmdStatus();
          if (tuiEnabled) renderTUI();
          await readLine();
          currentModal = null;
          if (tuiEnabled) renderTUI();
          break;

        case "music":
        case "catalog":
        case "songs":
          currentModal = "music";
          if (tuiEnabled) renderTUI();
          
          const musicManagementLoop = async () => {
            while (currentModal === "music") {
              if (tuiEnabled) renderTUI();
              const input = await readLine("music> ", 7, 21);
              if (input === null) break;
              
              if (!input) {
                if (tuiEnabled) renderTUI();
                continue;
              }

              const [cmd, ...cmdArgs] = input.split(/\s+/);

              try {
                switch (cmd.toLowerCase()) {
                  case "done":
                  case "exit":
                  case "close":
                  case "q":
                    currentModal = null;
                    if (tuiEnabled) renderTUI();
                    return;

                  case "add":
                    await cmdAddMusic(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "delete":
                  case "remove":
                    await cmdDeleteMusic(cmdArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "play":
                    if (cmdArgs.length < 1) {
                      addTUIMessage("Usage: play <index|name> [device]");
                      addTUIMessage("Example: play 1");
                      addTUIMessage("Example: play 1 2  (play track 1 on device 2)");
                      if (tuiEnabled) renderTUI();
                      break;
                    }
                    const identifier = cmdArgs[0];
                    let musicIndex = -1;
                    const index = parseInt(identifier);
                    if (!isNaN(index) && index > 0 && index <= config.musicCatalog.length) {
                      musicIndex = index - 1;
                    } else {
                      musicIndex = config.musicCatalog.findIndex(m => m.name.toLowerCase() === identifier.toLowerCase());
                    }
                    if (musicIndex === -1) {
                      addTUIMessage(`❌ Music not found: ${identifier}`);
                      if (tuiEnabled) renderTUI();
                      break;
                    }
                    const music = config.musicCatalog[musicIndex];
                    
                    const playArgs = [music.url];
                    if (cmdArgs.length > 1) {
                      playArgs.push(cmdArgs[1]);
                    }
                    
                    await cmdPlay(playArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  case "next":
                  case "n":
                    if (cmdArgs.length < 1) {
                      addTUIMessage("Usage: next <index|name> [device]");
                      addTUIMessage("Example: next 1");
                      addTUIMessage("Example: next 1 2  (queue track 1 on device 2)");
                      if (tuiEnabled) renderTUI();
                      break;
                    }
                    const nextIdentifier = cmdArgs[0];
                    let nextMusicIndex = -1;
                    const nextIndex = parseInt(nextIdentifier);
                    if (!isNaN(nextIndex) && nextIndex > 0 && nextIndex <= config.musicCatalog.length) {
                      nextMusicIndex = nextIndex - 1;
                    } else {
                      nextMusicIndex = config.musicCatalog.findIndex(m => m.name.toLowerCase() === nextIdentifier.toLowerCase());
                    }
                    if (nextMusicIndex === -1) {
                      addTUIMessage(`❌ Music not found: ${nextIdentifier}`);
                      if (tuiEnabled) renderTUI();
                      break;
                    }
                    
                    const nextArgs = [nextIdentifier];
                    if (cmdArgs.length > 1) {
                      nextArgs.push(cmdArgs[1]);
                    }
                    
                    await cmdNext(nextArgs);
                    if (tuiEnabled) renderTUI();
                    break;

                  default:
                    addTUIMessage(`Unknown command: ${cmd}. Use: add, delete, play, next, or done`);
                    if (tuiEnabled) renderTUI();
                }
              } catch (e) {
                addTUIMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
                if (tuiEnabled) renderTUI();
              }
            }
          };
          
          await musicManagementLoop();
          break;

        case "clear":
          tuiMessages = [];
          if (tuiEnabled) renderTUI();
          break;

        case "add-sonos":
          await cmdAddSonos(args);
          break;

        case "update-sonos":
        case "edit-sonos":
          await cmdUpdateSonos(args);
          break;

        case "delete-sonos":
        case "remove-sonos":
          await cmdDeleteSonos(args);
          break;

        default:
          addTUIMessage(`Unknown command: ${cmd}. Type 'help' for available commands.`);
          if (tuiEnabled) renderTUI();
      }
    } catch (e) {
      addTUIMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      if (tuiEnabled) renderTUI();
    }
  }
}

function showInteractiveHelp(): void {
  console.log(`
📚 Available Commands:
  
  scan [--verbose] [--timeout=MS]  Scan network for Sonos devices
  list, ls                          Show saved devices
  play <URL> [device]              Play YouTube URL (device = index or IP)
  next <URL|index|name> [device]  Queue song (URL or music library entry)
  pause                            Pause playback
  resume, res                      Resume playback from last position
  stop, s                          Stop current playback
  set-default <device>             Set default device (index or IP)
  status                           Show current status
  clear                            Clear screen
  help, h, ?                       Show this help
  exit, quit, q                    Exit CLI

🎯 Quick Start:
  1. Run 'scan' to find your Sonos
  2. Run 'set-default 1' to set the first device as default
  3. Run 'play https://youtu.be/...' to play a video

💡 Tips:
  - Device numbers refer to the list shown by 'scan' or 'list'
  - Your settings are saved in ${CONFIG_DIR}
  - Use 'scan --verbose' for detailed discovery info
  - Press Ctrl+C during playback to stop (doesn't exit CLI)
`);
}

// ============= Video Metadata =============
async function fetchVideoMetadata(url: string): Promise<VideoMetadata | null> {
  try {
    const ytdlpPath = await findCommandPath("yt-dlp");
    const cmd = new Deno.Command(ytdlpPath, {
      args: ["--dump-json", "--no-playlist", "--no-update", "--extractor-args", "youtube:player_client=android", url],
      stdout: "piped",
      stderr: "null",
    });
    
    const { stdout, success } = await cmd.output();
    if (!success) return null;
    
    const json = JSON.parse(new TextDecoder().decode(stdout));
    return {
      title: json.title || "Unknown Title",
      uploader: json.uploader || json.channel || "Unknown Artist",
      duration: json.duration || 0,
      thumbnail: json.thumbnail,
      description: json.description,
    };
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function secondsToHms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

// ============= TUI =============
type TUIView = "main" | "help" | "devices" | "status" | "music";
let tuiEnabled = false;
let tuiUpdateInterval: number | null = null;
let tuiMessages: string[] = [];
let currentModal: TUIView | null = null;
const MAX_MESSAGES = 3;
const TUI_WIDTH = 80;
const TUI_HEIGHT = 24;
const PROMPT_X = 1;
const PROMPT_Y = TUI_HEIGHT - 1;
let lastRenderTime = 0;
let renderScheduled = false;
let activePrompt: { prompt: string; x: number; y: number; width?: number; input: string } | null = null;
let rawModeEnabled = false;
type HelpContext = "main" | "devices" | "music" | "status";
let helpContext: HelpContext = "main";

function clearScreen(): void {
  Deno.stdout.writeSync(new TextEncoder().encode("\x1b[H\x1b[2J"));
}

function writeAnsi(s: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(s));
}

function enterAltScreen(): void {
  writeAnsi("\x1b[?1049h\x1b[?25l");
}

function exitAltScreen(): void {
  writeAnsi("\x1b[?1049l\x1b[?25h");
}

function enableRawMode(): void {
  if (rawModeEnabled) return;
  try {
    if (typeof Deno.setRaw === "function") {
      Deno.setRaw(Deno.stdin.rid, true);
    } else if (typeof (Deno.stdin as unknown as { setRaw?: (mode: boolean) => void }).setRaw === "function") {
      (Deno.stdin as unknown as { setRaw: (mode: boolean) => void }).setRaw(true);
    }
    rawModeEnabled = true;
  } catch {
    rawModeEnabled = false;
  }
}

function disableRawMode(): void {
  if (!rawModeEnabled) return;
  try {
    if (typeof Deno.setRaw === "function") {
      Deno.setRaw(Deno.stdin.rid, false);
    } else if (typeof (Deno.stdin as unknown as { setRaw?: (mode: boolean) => void }).setRaw === "function") {
      (Deno.stdin as unknown as { setRaw: (mode: boolean) => void }).setRaw(false);
    }
  } catch {
    // ignore
  } finally {
    rawModeEnabled = false;
  }
}

function moveCursor(row: number, col: number): void {
  Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[${row};${col}H`));
}

function setColor(fg?: string, bg?: string): void {
  const codes: Record<string, string> = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bgBlack: "\x1b[40m",
    bgBlue: "\x1b[44m",
    bgGreen: "\x1b[42m",
  };
  
  let output = "";
  if (fg) output += codes[fg] || "";
  if (bg) output += codes[bg] || "";
  Deno.stdout.writeSync(new TextEncoder().encode(output));
}

function resetColor(): void {
  Deno.stdout.writeSync(new TextEncoder().encode("\x1b[0m"));
}

function updatePromptLine(
  prompt: string,
  input: string,
  promptX: number,
  promptY: number,
  maxWidth?: number,
): void {
  const totalWidth = Math.max(0, (maxWidth ?? (TUI_WIDTH - promptX + 1)));

  const promptText = prompt.length > totalWidth ? prompt.slice(0, totalWidth) : prompt;
  const inputRoom = Math.max(0, totalWidth - promptText.length);

  const displayInput =
    input.length > inputRoom ? input.slice(input.length - inputRoom) : input;

  moveCursor(promptY, promptX);
  setColor("bright", "green");
  Deno.stdout.writeSync(new TextEncoder().encode(promptText));
  resetColor();

  setColor("white");
  Deno.stdout.writeSync(new TextEncoder().encode(displayInput));

  const padding = " ".repeat(Math.max(0, inputRoom - displayInput.length));
  Deno.stdout.writeSync(new TextEncoder().encode(padding));
  resetColor();

  moveCursor(promptY, promptX + promptText.length + displayInput.length);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

function drawBox(x: number, y: number, w: number, h: number, title?: string): void {
  moveCursor(y, x);
  Deno.stdout.writeSync(new TextEncoder().encode("┌" + "─".repeat(w - 2) + "┐"));
  if (title) {
    moveCursor(y, x + 2);
    setColor("bright", "white");
    Deno.stdout.writeSync(new TextEncoder().encode(title));
    resetColor();
  }
  for (let i = 1; i < h - 1; i++) {
    moveCursor(y + i, x);
    Deno.stdout.writeSync(new TextEncoder().encode("│" + " ".repeat(w - 2) + "│"));
  }
  moveCursor(y + h - 1, x);
  Deno.stdout.writeSync(new TextEncoder().encode("└" + "─".repeat(w - 2) + "┘"));
}

function writeAt(x: number, y: number, text: string): void {
  moveCursor(y, x);
  Deno.stdout.writeSync(new TextEncoder().encode(text));
}

function addTUIMessage(message: string): void {
  tuiMessages.unshift(message);
  if (tuiMessages.length > MAX_MESSAGES) {
    tuiMessages = tuiMessages.slice(0, MAX_MESSAGES);
  }
  if (tuiEnabled) renderTUI();
}

function renderHelpModal(): void {
  const modalW = 60;
  const modalH = 14;
  const modalX = Math.max(2, Math.floor((TUI_WIDTH - modalW) / 2));
  const modalY = 4;

  const titleByContext: Record<HelpContext, string> = {
    main: "Main Commands",
    devices: "Devices Commands",
    music: "Music Commands",
    status: "Status Commands",
  };

  const commandsByContext: Record<HelpContext, { cmd: string; desc: string }[]> = {
    main: [
      { cmd: "help", desc: "Show this help" },
      { cmd: "list", desc: "Manage saved devices" },
      { cmd: "music", desc: "Manage music catalog" },
      { cmd: "scan [--verbose]", desc: "Scan for Sonos devices" },
      { cmd: "play <URL> [dev]", desc: "Play YouTube URL" },
      { cmd: "pause | resume | stop", desc: "Control playback" },
      { cmd: "status", desc: "Show system status" },
      { cmd: "exit | quit", desc: "Exit application" },
    ],
    devices: [
      { cmd: "add <name> <ip>", desc: "Add new device" },
      { cmd: "edit <n> <name>", desc: "Change name only" },
      { cmd: "edit <n> <ip>", desc: "Change IP only" },
      { cmd: "edit <n> <name> <ip>", desc: "Change both" },
      { cmd: "delete <n>", desc: "Delete device #n" },
      { cmd: "set-default <n>", desc: "Set device #n as default" },
      { cmd: "done | exit | q", desc: "Close devices modal" },
    ],
    music: [
      { cmd: "add <url>", desc: "Add YouTube URL to catalog" },
      { cmd: "delete <n>", desc: "Delete track #n" },
      { cmd: "play <n> [dev]", desc: "Play track #n [on device]" },
      { cmd: "next <n> [dev]", desc: "Queue track #n [on device]" },
      { cmd: "done | exit | q", desc: "Close music modal" },
    ],
    status: [
      { cmd: "status", desc: "Refresh status view" },
      { cmd: "Enter / q", desc: "Close status modal" },
    ],
  };

  const title = ` 📚 Help - ${titleByContext[helpContext]} `;
  const commands = commandsByContext[helpContext];

  drawBox(modalX, modalY, modalW, modalH, title);

  let yPos = modalY + 2;

  setColor("dim", "yellow");
  writeAt(modalX + 2, yPos, "Type q or press Enter to close");
  resetColor();
  yPos += 2;

  setColor("bright", "cyan");
  writeAt(modalX + 2, yPos, "Commands");
  resetColor();
  yPos++;
  writeAt(modalX + 2, yPos, "─".repeat(modalW - 4));
  yPos++;

  for (const { cmd, desc } of commands) {
    setColor("bright", "white");
    writeAt(modalX + 2, yPos, truncate(cmd, 22));
    resetColor();
    setColor("dim", "white");
    writeAt(modalX + 26, yPos, truncate(desc, modalW - 30));
    resetColor();
    yPos++;
  }
}

function renderDevicesModal(): void {
  const modalX = 5;
  const modalY = 2;
  const modalW = 70;
  const modalH = 23;
  
  const deviceCount = config.devices.length;
  drawBox(modalX, modalY, modalW, modalH, ` 📡 Devices (${deviceCount}) `);
  
  const headerY = modalY + 2;
  setColor("bright", "cyan");
  writeAt(modalX + 2, headerY, "#");
  writeAt(modalX + 5, headerY, "Name");
  writeAt(modalX + 25, headerY, "IP Address");
  writeAt(modalX + 40, headerY, "Room");
  writeAt(modalX + 55, headerY, "Model");
  resetColor();
  
  setColor("dim", "white");
  writeAt(modalX + 2, headerY + 1, "─".repeat(modalW - 4));
  resetColor();
  
  const maxDeviceRows = (modalY + modalH - 10) - (modalY + 2) - 2;
  let yPos = headerY + 2;
  if (config.devices.length === 0) {
    setColor("dim", "yellow");
    writeAt(modalX + 2, yPos, "⚠️  No devices found. Use 'add <name> <ip>' to add one.");
    resetColor();
  } else {
    for (let i = 0; i < Math.min(config.devices.length, maxDeviceRows); i++) {
      const d = config.devices[i];
      const isDefault = d.ip === config.defaultDevice;
      
      setColor(isDefault ? "bright" : "dim", "white");
      writeAt(modalX + 2, yPos, `${(i + 1).toString().padStart(2)}`);
      resetColor();
      
      if (isDefault) {
        setColor("bright", "yellow");
        writeAt(modalX + 5, yPos, truncate("⭐ " + d.name, 18));
      } else {
        setColor("bright", "white");
        writeAt(modalX + 5, yPos, truncate(d.name, 18));
      }
      resetColor();
      
      setColor("white");
      writeAt(modalX + 25, yPos, truncate(d.ip, 13));
      resetColor();
      
      setColor("dim", "white");
      writeAt(modalX + 40, yPos, truncate(d.room, 13));
      resetColor();
      
      setColor("dim", "white");
      writeAt(modalX + 55, yPos, truncate(d.model, 12));
      resetColor();
      
      yPos++;
    }
  }
  
  const hintY = modalY + modalH - 2;
  setColor("dim", "yellow");
  writeAt(modalX + 2, hintY, "💡 Type 'help' for device commands");
  resetColor();
}

function renderMusicModal(): void {
  const modalX = 5;
  const modalY = 2;
  const modalW = 70;
  const modalH = 20;
  
  const trackCount = config.musicCatalog.length;
  drawBox(modalX, modalY, modalW, modalH, ` 📻 Music Catalog (${trackCount} tracks) `);
  
  const headerY = modalY + 2;
  setColor("bright", "cyan");
  writeAt(modalX + 2, headerY, "#");
  writeAt(modalX + 5, headerY, "Name");
  writeAt(modalX + 25, headerY, "Title");
  writeAt(modalX + 50, headerY, "Artist");
  resetColor();
  
  setColor("dim", "white");
  writeAt(modalX + 2, headerY + 1, "─".repeat(modalW - 4));
  resetColor();
  
  let yPos = headerY + 2;
  if (config.musicCatalog.length === 0) {
    setColor("dim", "yellow");
    writeAt(modalX + 2, yPos, "⚠️  No music in catalog. Use 'add <url>' to add tracks.");
    resetColor();
  } else {
    for (let i = 0; i < Math.min(config.musicCatalog.length, 12); i++) {
      const m = config.musicCatalog[i];
      
      setColor("dim", "white");
      writeAt(modalX + 2, yPos, `${(i + 1).toString().padStart(2)}`);
      resetColor();
      
      setColor("bright", "white");
      writeAt(modalX + 5, yPos, truncate(m.name, 18));
      resetColor();
      
      setColor("white");
      writeAt(modalX + 25, yPos, truncate(m.title || "-", 23));
      resetColor();
      
      setColor("dim", "white");
      writeAt(modalX + 50, yPos, truncate(m.artist || "-", 17));
      resetColor();
      
      yPos++;
    }
  }
  
  const hintY = modalY + modalH - 2;
  setColor("dim", "yellow");
  writeAt(modalX + 2, hintY, "💡 Type 'help' for music commands");
  resetColor();
}

function renderStatusModal(): void {
  const modalX = 8;
  const modalY = 2;
  const modalW = 64;
  const modalH = 20;
  
  drawBox(modalX, modalY, modalW, modalH, " System Status ");
  
  let yPos = modalY + 2;
  setColor("bright", "cyan");
  writeAt(modalX + 2, yPos, "System:");
  resetColor();
  yPos++;
  
  setColor("white");
  writeAt(modalX + 2, yPos, `  Config: ${truncate(CONFIG_DIR, 45)}`);
  yPos++;
  writeAt(modalX + 2, yPos, `  Default: ${config.defaultDevice || "Not set"}`);
  yPos++;
  writeAt(modalX + 2, yPos, `  Devices: ${config.devices.length}`);
  yPos++;
  writeAt(modalX + 2, yPos, `  Last scan: ${config.lastScan ? new Date(config.lastScan).toLocaleString() : "Never"}`);
  yPos++;
  writeAt(modalX + 2, yPos, `  Port: ${config.httpPort || "Auto"}`);
  resetColor();
  
  yPos += 2;
  setColor("bright", "cyan");
  writeAt(modalX + 2, yPos, "Playback:");
  resetColor();
  yPos++;
  
  setColor(playbackState.isPlaying ? "green" : "dim");
  writeAt(modalX + 2, yPos, `  Status: ${playbackState.isPlaying ? "● Playing" : "○ Stopped"}`);
  resetColor();
  
  if (playbackState.currentMetadata) {
    const meta = playbackState.currentMetadata;
    yPos++;
    setColor("white");
    writeAt(modalX + 2, yPos, `  Title: ${truncate(meta.title, 45)}`);
    yPos++;
    writeAt(modalX + 2, yPos, `  Artist: ${truncate(meta.uploader, 45)}`);
    if (meta.duration > 0) {
      yPos++;
      writeAt(modalX + 2, yPos, `  Duration: ${formatDuration(meta.duration)}`);
    }
    resetColor();
  }
  
  if (playbackState.currentDevice) {
    const dev = playbackState.currentDevice;
    yPos += 2;
    setColor("bright", "cyan");
    writeAt(modalX + 2, yPos, "Device:");
    resetColor();
    yPos++;
    setColor("white");
    writeAt(modalX + 2, yPos, `  ${dev.name} (${dev.room})`);
    yPos++;
    writeAt(modalX + 2, yPos, `  ${dev.model} | ${dev.ip}`);
    resetColor();
  }
  
  setColor("dim", "yellow");
  writeAt(modalX + 2, modalY + modalH - 2, "Press Enter to close...");
  resetColor();
}

function renderProgressBar(current: number, total: number, width: number): string {
  if (total <= 0) return "─".repeat(width);
  const filled = Math.floor((current / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return bar;
}

function renderMainView(): void {
  clearScreen();

  const headerY = 1;
  const nowPlayingY = 3;
  const deviceY = 10;
  const statusY = 15;
  const messagesY = 19;
  const shortcutsY = PROMPT_Y - 1;
  const promptY = PROMPT_Y;
  
  setColor("bright", "cyan");
  writeAt(1, headerY, "╔" + "═".repeat(TUI_WIDTH - 2) + "╗");
  resetColor();
  setColor("bright", "bgBlue");
  const title = " 🎵 Sonos YouTube Player ";
  const titleX = Math.floor((TUI_WIDTH - title.length) / 2);
  writeAt(titleX, headerY + 1, title);
  resetColor();
  setColor("bright", "cyan");
  writeAt(1, headerY + 2, "╚" + "═".repeat(TUI_WIDTH - 2) + "╝");
  resetColor();
  
  drawBox(1, nowPlayingY, TUI_WIDTH, 6, " ▶ Now Playing ");
  const trackY = nowPlayingY + 1;
  if (playbackState.isPlaying && playbackState.currentMetadata) {
    const meta = playbackState.currentMetadata;
    
    setColor("bright", "white");
    const statusIcon = playbackState.isPaused ? "⏸️ " : "▶️ ";
    writeAt(3, trackY, statusIcon + truncate(meta.title, TUI_WIDTH - 8));
    resetColor();
    
    
    if (meta.duration > 0 && playbackState.lastPosition !== undefined) {
      const position = playbackState.lastPosition;
      const progressWidth = TUI_WIDTH - 10;
      const progressBar = renderProgressBar(position, meta.duration, progressWidth);
      
      setColor(playbackState.isPaused ? "yellow" : "green");
      writeAt(3, trackY + 2, progressBar);
      resetColor();
      
      setColor("bright", "yellow");
      const timeStr = `${formatDuration(position)} / ${formatDuration(meta.duration)}`;
      writeAt(3, trackY + 3, timeStr);
      resetColor();
    } else if (meta.duration > 0) {
      setColor("dim", "white");
      writeAt(3, trackY + 2, `Duration: ${formatDuration(meta.duration)}`);
      resetColor();
    }
  } else {
    setColor("dim", "white");
    writeAt(3, trackY + 1, "No track playing");
    setColor("dim", "yellow");
    writeAt(3, trackY + 2, "Type 'play <URL>' to start");
    resetColor();
  }
  
  drawBox(1, deviceY, TUI_WIDTH, 4, " 📡 Device ");
  const deviceInfoY = deviceY + 1;
  if (playbackState.currentDevice) {
    const dev = playbackState.currentDevice;
    setColor("bright", "white");
    writeAt(3, deviceInfoY, `🎯 ${truncate(dev.name, TUI_WIDTH - 8)}`);
    resetColor();
    if (dev.room) {
      setColor("dim", "white");
      writeAt(3, deviceInfoY + 1, `   ${dev.room}`);
      resetColor();
    }
  } else if (config.defaultDevice) {
    const dev = config.devices.find(d => d.ip === config.defaultDevice);
    if (dev) {
      setColor("bright", "white");
      writeAt(3, deviceInfoY, `⭐ ${truncate(dev.name, TUI_WIDTH - 8)} (Default)`);
      resetColor();
      if (dev.room) {
        setColor("dim", "white");
        writeAt(3, deviceInfoY + 1, `   ${dev.room}`);
        resetColor();
      }
    } else {
      setColor("dim", "yellow");
      writeAt(3, deviceInfoY, `⚠️  Default device not found: ${config.defaultDevice}`);
      resetColor();
    }
  } else {
    setColor("dim", "yellow");
    writeAt(3, deviceInfoY, "⚠️  No device selected - Use 'scan' or 'list'");
    resetColor();
  }
  
  drawBox(1, statusY, TUI_WIDTH, 4, " 📊 Status ");
  const statusInfoY = statusY + 1;
  
  let statusIcon = "○";
  let statusText = "Stopped";
  let statusColor: string = "dim";
  if (playbackState.isPaused) {
    statusIcon = "⏸️";
    statusText = "Paused";
    statusColor = "yellow";
  } else if (playbackState.isPlaying) {
    statusIcon = "▶️";
    statusText = "Playing";
    statusColor = "green";
  }
  
  setColor(statusColor === "dim" ? "dim" : statusColor, statusColor === "dim" ? undefined : "white");
  writeAt(3, statusInfoY, `${statusIcon} ${statusText}`);
  resetColor();
  
  
  drawBox(1, messagesY, TUI_WIDTH, 3, " 💬 Messages ");
  const msgY = messagesY + 1;
  if (tuiMessages.length > 0) {
    setColor("dim", "yellow");
    writeAt(3, msgY, truncate(tuiMessages[0], TUI_WIDTH - 6));
    resetColor();
  } else {
    setColor("dim", "white");
    writeAt(3, msgY, "Ready");
    resetColor();
  }
  
  if (!currentModal) {
    setColor("dim", "white");
    writeAt(1, shortcutsY, "💡 Quick: help | list | music | play <URL> | pause | resume | stop");
    resetColor();
  } else {
    writeAt(1, shortcutsY, " ".repeat(TUI_WIDTH - 1));
  }
  
  const promptState = activePrompt ?? {
    prompt: "sonos> ",
    x: PROMPT_X,
    y: promptY,
    width: TUI_WIDTH - (PROMPT_X - 1),
    input: "",
  };
  updatePromptLine(
    promptState.prompt,
    promptState.input,
    promptState.x,
    promptState.y,
    promptState.width,
  );
  
  if (currentModal === "help") {
    renderHelpModal();
  } else if (currentModal === "devices") {
    renderDevicesModal();
  } else if (currentModal === "status") {
    renderStatusModal();
  } else if (currentModal === "music") {
    renderMusicModal();
  }
}

function renderTUI(): void {
  if (!tuiEnabled) return;
  const now = Date.now();
  const delta = now - lastRenderTime;
  if (delta < 16) {
    if (!renderScheduled) {
      renderScheduled = true;
      setTimeout(() => {
        renderScheduled = false;
        if (!tuiEnabled) return;
        renderMainView();
        lastRenderTime = Date.now();
      }, 16 - delta);
    }
    return;
  }
  renderMainView();
  lastRenderTime = now;
}

async function startTUI(): Promise<void> {
  tuiEnabled = true;
  enterAltScreen();
  enableRawMode();
  clearScreen();
  renderTUI();
  
}

function stopTUI(): void {
  tuiEnabled = false;
  clearScreen();
  disableRawMode();
  exitAltScreen();
}

// ============= Utilities =============
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function headerValue(rawResponse: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "mi");
  const m = re.exec(rawResponse);
  return m ? m[1].trim() : null;
}

async function chooseAvailablePort(start: number, end: number): Promise<number> {
  for (let p = start; p <= end; p++) {
    try {
      const listener = Deno.listen({ hostname: "0.0.0.0", port: p });
      listener.close();
      return p;
    } catch (e) {
      console.log(`Port ${p} in use, trying next`);
    }
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findCommandPath(command: string): Promise<string> {
  try {
    const cmd = new Deno.Command(command, { args: ["--version"], stdout: "null", stderr: "null" });
    const status = await cmd.output();
    if (status.success) return command;
  } catch {
    console.log(`Command ${command} not found in PATH`);
  }
  
  const paths = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `/usr/bin/${command}`,
  ];
  
  for (const path of paths) {
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) {
        return path;
      }
    } catch {
      console.log(`Path ${path} doesn't exist`);
    }
  }
  
  return command;
}

async function checkDependencies(): Promise<boolean> {
  const deps = ["yt-dlp", "ffmpeg"];
  const missing: string[] = [];

  for (const dep of deps) {
    try {
      const cmd = new Deno.Command(dep, { args: ["--version"], stdout: "null", stderr: "null" });
      const status = await cmd.output();
      if (!status.success) throw new Error("Command failed");
    } catch {
      console.log(`Command ${dep} not found in PATH`);
      const brewPaths = [
        `/opt/homebrew/bin/${dep}`,
        `/usr/local/bin/${dep}`,
        `/usr/bin/${dep}`,
      ];
      
      let found = false;
      for (const path of brewPaths) {
        try {
          const stat = await Deno.stat(path);
          if (stat.isFile) {
            found = true;
            break;
          }
        } catch {
          console.log(`Path ${path} doesn't exist`);
        }
      }
      
      if (!found) {
        missing.push(dep);
      }
    }
  }

  if (missing.length > 0) {
    addTUIMessage(`❌ Missing dependencies: ${missing.join(", ")}`);
    if (missing.includes("yt-dlp")) {
      addTUIMessage("Install: pip install yt-dlp or brew install yt-dlp");
    }
    if (missing.includes("ffmpeg")) {
      addTUIMessage("Install: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)");
    }
    addTUIMessage("If installed, try: export PATH=$PATH:/opt/homebrew/bin:/usr/local/bin");
    if (tuiEnabled) renderTUI();
    return false;
  }

  return true;
}

// ============= Main Entry Point =============
async function main() {
  await loadConfig();

  const args = parse(Deno.args);
  const positional = args._ as string[];

  if (positional.length > 0) {
    const cmd = positional[0].toString();
    
    switch (cmd) {
      case "scan":
        await cmdScan(Deno.args.slice(1));
        break;
      
      case "list":
        await cmdList();
        break;
      
      case "play":
        await cmdPlay(positional.slice(1).map(String));
        break;
      
      case "stop":
        await cmdStop();
        break;
      
      case "help":
      case "--help":
      case "-h":
        showHelp();
        break;
      
      default:
        if (cmd.startsWith("http")) {
          await cmdPlay(positional.map(String));
        } else {
          console.log(`Unknown command: ${cmd}`);
          showHelp();
        }
    }
  } else {
    await interactiveCLI();
  }
}

function showHelp(): void {
  console.log(`
🎵 Sonos YouTube Player CLI

Usage:
  sonos-cli                        Start interactive CLI
  sonos-cli <command> [options]    Run a command directly

Commands:
  scan [--verbose] [--timeout=ms]  Scan for Sonos devices
  list                             List saved devices
  play <URL> [device]              Play YouTube URL
  next <URL|index|name> [device]   Queue song (URL or music library entry)
  stop                             Stop playback
  help                             Show this help

Examples:
  sonos-cli                        # Start interactive mode
  sonos-cli scan                   # Scan for devices
  sonos-cli play https://youtu.be/xxx  # Play on default device
  sonos-cli play https://youtu.be/xxx 192.168.1.50  # Play on specific IP

Backward compatible:
  sonos-cli https://youtu.be/xxx   # Play URL directly
`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`Fatal error: ${e}`);
    await closeLogging();
    Deno.exit(1);
  }
}