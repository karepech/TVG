import fs from "fs";
import fetch from "node-fetch";
import axios from "axios";

/*
  generate-raw-grouped.js 
  - FINAL PRODUKSI: Mengganti Nama Channel dengan detail Event yang sedang/akan berlangsung.
  - Exception List: Menganggap channel lokal/premium selalu online.
*/

// Sumber M3U lokal di repositori Anda
const LOCAL_M3U_FILES = ["live.m3u", "bw.m3u"]; 

// Sumber eksternal tambahan
const SOURCE_M3US = [
  "https://getch.semar.my.id/",
  "https://bakulwifi.my.id/bw.m3u"
];
const MAX_DAYS_AHEAD = 2; 

// ======================= HELPER FUNCTIONS =======================

function formatDateForM3U(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function convertUtcToWib(utcTime, dateString) {
    if (!utcTime) return "Waktu Tidak Tersedia";
    
    const [year, month, day] = dateString.split('-');
    const dateTimeUtc = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(utcTime.slice(0, 2)), parseInt(utcTime.slice(3, 5))));

    dateTimeUtc.setHours(dateTimeUtc.getHours() + 7);

    const hours = String(dateTimeUtc.getHours()).padStart(2, '0');
    const minutes = String(dateTimeUtc.getMinutes()).padStart(2, '0');
    
    return `${hours}:${minutes} WIB`;
}

function getFutureDates() {
  const dates = [];
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push({
      apiDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      m3uDate: d,
      isToday: i === 0,
      dateKey: formatDateForM3U(d)
    });
  }
  return dates;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return "";
    return await res.text();
  } catch (e) {
    console.error("fetchText error for", url, e.message);
    return "";
  }
}

async function headOk(url, sourceTag) {
  // Exception List: Menganggap channel lokal/premium selalu online
  if (sourceTag.includes("LOCAL_FILE") || sourceTag.includes("BW_M3U") || !url.startsWith('http')) { 
      return true;
  }
  
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('bein') || lowerUrl.includes('spotv') || lowerUrl.includes('dazn')) { 
      return true;
  }

  try {
    const res = await axios.head(url, { 
        timeout: 7000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Referer': 'https://www.google.com'
        }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function loadChannelMap() {
  try {
    const raw = fs.readFileSync("./channel-map.json", "utf8");
    const cleanedJson = raw.replace(/\/\*[\s\S]*?\*\/|(?:\/\/).*/g, '');
    return JSON.parse(cleanedJson);
  } catch (e) {
    console.warn("Warning: channel-map.json not found or invalid. Matching will rely only on team/league names. Error:", e.message);
    return {};
  }
}

function getExtinfAttributes(extinfLine) {
    const attributes = {};
    const regex = /(\S+?)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(extinfLine)) !== null) {
        attributes[match[1]] = match[2];
    }
    return attributes;
}

function extractChannelsFromM3U(m3u, sourceTag) {
  const lines = m3u.split(/\r?\n/);
  const channels = [];
  
  let currentExtInf = null;
  let currentVlcOpts = [];
  
  let counter = 0; 

  for (const l of lines) {
    const trimmedLine = l.trim();

    if (trimmedLine.startsWith("#EXTINF")) {
      currentExtInf = trimmedLine;
      currentVlcOpts = []; 

    } else if (trimmedLine.startsWith("#EXTVLCOPT") || trimmedLine.startsWith("#KODIPROP")) {
      currentVlcOpts.push(trimmedLine);
      
    } else if (currentExtInf && (trimmedLine.startsWith("http") || trimmedLine.startsWith("rtmp") || trimmedLine.startsWith("udp"))) {
      const namePart = currentExtInf.split(/,(.*)$/)[1]?.trim() || '';
      
      channels.push({ 
          uniqueId: `${sourceTag}-${counter++}`, 
          extinf: currentExtInf, 
          name: namePart, 
          url: trimmedLine,
          source: sourceTag,
          vlcOpts: [...currentVlcOpts] 
      });
      
      currentExtInf = null; 
      currentVlcOpts = [];
    }
  }
  return channels;
}

async function fetchAndGroupEvents() {
    const dates = getFutureDates();
    const groupedEvents = {
        live: { keywords: new Set(), events: [] },
        upcoming: { keywords: new Set(), events: [] }
    };
    
    for (const d of dates) {
        const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${d.apiDate}&s=Soccer`;
        const txt = await fetchText(url);
        
        if (txt) {
            try {
                const events = JSON.parse(txt).events || [];
                const targetGroup = d.isToday ? groupedEvents.live : groupedEvents.upcoming;
                
                events.forEach(ev => {
                    const wibTime = convertUtcToWib(ev.strTime, ev.dateEvent);
                    const eventDetail = `${ev.strHomeTeam} vs ${ev.strAwayTeam} (${wibTime}) - ${d.dateKey}`;

                    targetGroup.events.push({
                        detail: eventDetail,
                        keywords: [ev.strHomeTeam, ev.strAwayTeam, ev.strLeague, ev.strEvent],
                        timeWib: wibTime
                    });
                    
                    if (ev.strHomeTeam) targetGroup.keywords.add(ev.strHomeTeam);
                    if (ev.strAwayTeam) targetGroup.keywords.add(ev.strAwayTeam);
                    if (ev.strLeague) targetGroup.keywords.add(ev.strLeague);
                    if (ev.strEvent) targetGroup.keywords.add(ev.strEvent); 
                });
            } catch (e) {
                console.error("Error parsing events:", e.message);
            }
        }
    }
    
    // HACK: Menambahkan keyword umum untuk meningkatkan Live matching
    groupedEvents.live.keywords.add("bein sports");
    groupedEvents.live.keywords.add("premier league"); 
    groupedEvents.live.keywords.add("spotv");

    return groupedEvents;
}


function channelMatchesKeywords(channelName, eventKeywords, channelMap) {
  const ln = channelName.toLowerCase();

  for (const k of eventKeywords) {
    const lowerK = k.toLowerCase();
    if (ln.includes(lowerK)) return true;

    if (channelMap[lowerK]) {
      for (const channelKeyword of channelMap[lowerK]) {
        if (ln.includes(channelKeyword.toLowerCase())) {
          return true;
        }
      }
    }
  }
  return false;
}

// ========================== MAIN ==========================

async function main() {
  console.log("Starting generate-raw-grouped.js (Final Production Run)...");

  const channelMap = loadChannelMap();

  // --- Langkah 1: Ambil SEMUA Channel ---
  let allChannelsRaw = [];
  
  for (const localFile of LOCAL_M3U_FILES) {
      try {
          const localM3uContent = fs.readFileSync(localFile, 'utf8');
          const tag = localFile.toUpperCase().replace(/\./g, '_'); 
          allChannelsRaw = allChannelsRaw.concat(extractChannelsFromM3U(localM3uContent, tag));
      } catch (e) {
          console.error(`FATAL: Could not read local file ${localFile}. Skipping.`);
      }
  }

  for (const src of SOURCE_M3US) {
    const m3u = await fetchText(src);
    if (m3u) allChannelsRaw = allChannelsRaw.concat(extractChannelsFromM3U(m3u, "EXTERNAL_SOURCE"));
  }
  
  const onlineChannelsMap = new Map();
  let uniqueCount = new Set(); 
  
  const onlineCheckPromises = allChannelsRaw.map(async (ch) => {
    const sourceTag = ch.source;

    const ok = await headOk(ch.url, sourceTag); 
    if (ok) {
        onlineChannelsMap.set(ch.uniqueId, ch); 
        uniqueCount.add(ch.url); 
    }
  });

  await Promise.all(onlineCheckPromises);
  const onlineChannels = Array.from(onlineChannelsMap.values());
  console.log("Total channels verified as ONLINE:", onlineChannels.length);

  // --- Langkah 3: Ambil Jadwal Event & Kelompokkan ---
  const groupedEvents = await fetchAndGroupEvents();
  
  // --- Langkah 4: Kumpulkan Hasil Output ke Grup-grup ---
  const generatedTime = new Date().toISOString();
  const output = [`#EXTM3U url-version="${generatedTime}"`]; 
  
  const addedChannelIds = new Set();
  
  // A. Grup LIVE EVENT (Hari Ini - H0)
  const liveKeywords = groupedEvents.live.keywords;
  const liveEventsList = groupedEvents.live.events;
  
  output.push(`\n#EXTINF:-1 group-title="⚽ LIVE EVENT", HARI INI - ${liveEventsList.length} Event`);
  
  let liveEventCount = 0;
  
  // Tampilkan daftar event live sebagai header info
  liveEventsList.forEach(e => {
      output.push(`# EVENT INFO: ${e.detail}`);
  });

  for (const ch of onlineChannels) {
      if (!addedChannelIds.has(ch.uniqueId) && channelMatchesKeywords(ch.name, liveKeywords, channelMap)) {
          
          const matchingEvent = liveEventsList.find(event => channelMatchesKeywords(ch.name, event.keywords, channelMap));
          
          const attributes = getExtinfAttributes(ch.extinf);
          
          const newChannelName = matchingEvent ? matchingEvent.detail : ch.name;
          
          let newExtInf = '#EXTINF:-1 ';
          for (const key in attributes) {
              if (key !== 'group-title') {
                  newExtInf += `${key}="${attributes[key]}" `;
              }
          }
          newExtInf += `,${newChannelName}`;

          if (ch.vlcOpts.length > 0) output.push(...ch.vlcOpts);
          output.push(newExtInf.replace(/group-title="[^"]*"/g, `group-title="⚽ LIVE EVENT"`));
          output.push(ch.url);
          addedChannelIds.add(ch.uniqueId);
          liveEventCount++;
      }
  }


  // B. Grup UPCOMING EVENTS (H+1 dan H+2)
  const upcomingKeywords = groupedEvents.upcoming.keywords;
  const upcomingEventsList = groupedEvents.upcoming.events;
  
  output.push(`\n#EXTINF:-1 group-title="📅 UPCOMING EVENTS", MENDATANG - ${upcomingEventsList.length} Event`);
  
  let upcomingEventCount = 0;
  
  // Tampilkan daftar event mendatang (Nama Tim, Jam WIB, Tanggal)
  upcomingEventsList.forEach(e => {
      output.push(`# EVENT INFO: ${e.detail}`);
  });

  for (const ch of onlineChannels) {
      if (!addedChannelIds.has(ch.uniqueId) && channelMatchesKeywords(ch.name, upcomingKeywords, channelMap)) {
          
          const matchingEvent = upcomingEventsList.find(event => channelMatchesKeywords(ch.name, event.keywords, channelMap));
          
          const attributes = getExtinfAttributes(ch.extinf);
          const newChannelName = matchingEvent ? matchingEvent.detail : ch.name;
          
          let newExtInf = '#EXTINF:-1 ';
          for (const key in attributes) {
              if (key !== 'group-title') {
                  newExtInf += `${key}="${attributes[key]}" `;
              }
          }
          newExtInf += `,${newChannelName}`;

          if (ch.vlcOpts.length > 0) output.push(...ch.vlcOpts);
          output.push(newExtInf.replace(/group-title="[^"]*"/g, `group-title="📅 UPCOMING EVENTS"`));
          output.push(ch.url);
          addedChannelIds.add(ch.uniqueId);
          upcomingEventCount++;
      }
  }
  
  // C. Grup ALL SPORTS CHANNELS (Semua Saluran Online Lainnya)
  const remainingCount = onlineChannels.length - addedChannelIds.size;
  output.push(`\n#EXTINF:-1 group-title="⭐ ALL SPORTS CHANNELS", ${remainingCount} Channel Aktif Lainnya`);
  let allOnlineCount = 0;
  for (const ch of onlineChannels) {
    if (!addedChannelIds.has(ch.uniqueId)) {
        
        if (ch.vlcOpts.length > 0) output.push(...ch.vlcOpts);
        output.push(ch.extinf.replace(/group-title="[^"]*"/g, `group-title="⭐ ALL SPORTS CHANNELS"`));
        output.push(ch.url);
        addedChannelIds.add(ch.uniqueId);
        allOnlineCount++;
    }
  }
  
  // --- Langkah 5: Tulis file M3U dan Statistik ---
  const FILENAME_M3U = "live-raw-grouped.m3u"; 
  const FILENAME_STATS = "live-raw-stats.json";

  fs.writeFileSync(FILENAME_M3U, output.join("\n") + "\n");

  const stats = {
    fetchedTotalRaw: allChannelsRaw.length,
    uniqueUrlsOnline: uniqueCount.size,
    onlineTotalRaw: onlineChannels.length,
    onlineLive: liveEventCount,
    onlineUpcoming: upcomingEventCount,
    onlineGeneral: allOnlineCount,
    generatedAt: new Date().toISOString()
  };

  fs.writeFileSync(FILENAME_STATS, JSON.stringify(stats, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log("Total Online Channels Added (Including Duplicates):", onlineChannels.length);
  console.log("Channels in 'LIVE EVENT' group:", liveEventCount);
  console.log("Channels in 'UPCOMING EVENTS' group:", upcomingEventCount);
  console.log("Channels in 'ALL SPORTS CHANNELS' group (catch-all):", allOnlineCount);
  console.log("Generated", FILENAME_M3U);
  console.log("Stats saved to", FILENAME_STATS);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
