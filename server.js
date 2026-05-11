import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Innertube, Platform } from 'youtubei.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: true });

// Platform eval shim (required for youtubei.js in Node)
Platform.shim.eval = async (data, env) => {
  const properties = [];
  if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
  return new Function(code)();
};

// Initialize Innertube once
let yt;
try {
  yt = await Innertube.create({
    cache: false,
    generate_session_locally: true,
    retrieve_player: true,
  });
  console.log('Innertube initialized');
} catch (err) {
  console.error('Failed to initialize Innertube:', err);
  process.exit(1);
}

// Serve static files
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

fastify.get('/favicon.ico', (req, reply) => reply.code(204).send());

// Format video — no shorts-specific treatment, all videos render the same
const formatVideo = (v) => {
  const id =
    v.id?.toString() ||
    v.video_id?.toString() ||
    v.endpoint?.payload?.videoId;
  if (!id) return null;
  return {
    id,
    title: v.title?.text || v.title?.toString() || 'Unknown',
    author: v.author?.name || v.author?.toString() || 'Unknown',
    authorId: v.author?.id || v.author?.endpoint?.payload?.browseId || null,
    duration: v.duration?.text || 'N/A',
    durationSeconds: v.duration?.seconds || 0,
    thumbnail: v.thumbnails?.at(-1)?.url || v.thumbnail?.at(-1)?.url || '',
  };
};

// ─── SEARCH (no server-side history — client handles it) ──────────────────────
fastify.get('/api/search', async (request, reply) => {
  const { q } = request.query;
  if (!q) return reply.status(400).send({ error: 'Missing query' });
  try {
    const results = await yt.search(q, { type: 'video' });
    return results.videos.map(formatVideo).filter(Boolean);
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ─── VIDEO INFO ───────────────────────────────────────────────────────────────
fastify.get('/api/stream/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    return {
      id,
      title: info.basic_info.title || 'Unknown',
      author: info.basic_info.author || 'Unknown',
      authorId: info.basic_info.channel_id || null,
      description: info.basic_info.short_description?.slice(0, 600) || '',
      viewCount: info.basic_info.view_count || 0,
      likeCount: info.basic_info.like_count || 0,
      thumbnail: info.basic_info.thumbnail?.[0]?.url || '',
      hasCaptions: (info.captions?.caption_tracks?.length || 0) > 0,
    };
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ─── SHARED STREAM PROXY ──────────────────────────────────────────────────────
async function proxyStream(id, audioOnly, request, reply, prefetchedInfo = null) {
  try {
    const info = prefetchedInfo || await yt.getInfo(id);
    let format;
    try {
      format = audioOnly
        ? info.chooseFormat({ quality: 'best', type: 'audio' })
        : info.chooseFormat({ quality: '360p', type: 'video+audio' });
    } catch {
      format = info.chooseFormat({ type: 'video+audio' });
    }
    const streamUrl = await format.decipher(yt.session.player);
    const headers = {
      'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
      'Accept': '*/*',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    };
    if (request.headers['range']) headers['Range'] = request.headers['range'];
    const response = await fetch(streamUrl, { headers });
    if (!response.ok && response.status !== 206)
      return reply.status(502).send({ error: `YouTube returned ${response.status}` });
    reply.code(response.status);
    reply.header('Content-Type', response.headers.get('content-type') || (audioOnly ? 'audio/mp4' : 'video/mp4'));
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Access-Control-Allow-Origin', '*');
    const cr = response.headers.get('content-range');
    if (cr) reply.header('Content-Range', cr);
    const cl = response.headers.get('content-length');
    if (cl) reply.header('Content-Length', cl);
    return reply.send(response.body);
  } catch (error) {
    fastify.log.error(`Proxy error for ${id}: ${error.message}`);
    if (!reply.sent) return reply.status(500).send({ error: error.message });
  }
}

// ─── AUDIO PROXY (registered before video proxy — more specific path) ─────────
fastify.get('/api/proxy/audio/:id', (req, reply) =>
  proxyStream(req.params.id, true, req, reply));

// ─── VIDEO PROXY ──────────────────────────────────────────────────────────────
fastify.get('/api/proxy/:id', (req, reply) =>
  proxyStream(req.params.id, false, req, reply));

// ─── AUDIO DOWNLOAD ───────────────────────────────────────────────────────────
fastify.get('/api/download/audio/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    const title = (info.basic_info.title || id).replace(/[^\w\s\-]/g, '').trim();
    reply.header('Content-Disposition', `attachment; filename="${title}.m4a"`);
    return proxyStream(id, true, request, reply, info);
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ─── VIDEO DOWNLOAD ───────────────────────────────────────────────────────────
fastify.get('/api/download/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    const title = (info.basic_info.title || id).replace(/[^\w\s\-]/g, '').trim();
    reply.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
    return proxyStream(id, false, request, reply, info);
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ─── CAPTIONS (returns WebVTT) ─────────────────────────────────────────────────
fastify.get('/api/captions/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    const tracks = info.captions?.caption_tracks;
    if (!tracks?.length) return reply.status(404).send({ error: 'No captions available' });
    const track = tracks.find(t => t.language_code === 'en') || tracks[0];
    // Try native VTT format first
    const vttRes = await fetch(track.base_url + '&fmt=vtt');
    if (vttRes.ok) {
      reply.header('Content-Type', 'text/vtt');
      return vttRes.text();
    }
    // Fallback: parse json3 and convert
    const j3Res = await fetch(track.base_url + '&fmt=json3');
    if (!j3Res.ok) return reply.status(502).send({ error: 'Could not fetch captions' });
    reply.header('Content-Type', 'text/vtt');
    return json3ToVTT(await j3Res.json());
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

function msFmtVTT(ms) {
  const s = ms / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

function json3ToVTT(json) {
  let vtt = 'WEBVTT\n\n';
  for (const evt of (json?.events || [])) {
    if (!evt.segs) continue;
    const text = evt.segs.map(s => s.utf8 || '').join('').trim();
    if (!text) continue;
    const start = evt.tStartMs || 0;
    const end = start + (evt.dDurationMs || 2000);
    vtt += `${msFmtVTT(start)} --> ${msFmtVTT(end)}\n${text}\n\n`;
  }
  return vtt;
}

// ─── CHANNEL (improved: banner + description) ──────────────────────────────────
fastify.get('/api/channel/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const channel = await yt.getChannel(id);
    const videosPage = await channel.getVideos();
    return {
      title: channel.metadata.title || 'Unknown Channel',
      description: channel.metadata.description || '',
      thumbnail: channel.metadata.thumbnail?.at(-1)?.url || '',
      banner:
        channel.header?.banner?.at(-1)?.url ||
        channel.header?.tv_banner?.at(-1)?.url ||
        null,
      subscribers: channel.metadata.subscriber_count || '',
      videoCount: channel.metadata.videos_count || '',
      videos: (videosPage.videos || []).map(formatVideo).filter(Boolean),
    };
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ─── TRENDING (client sends its search terms for personalisation) ──────────────
fastify.get('/api/trending', async (request, reply) => {
  try {
    const { terms } = request.query;
    if (terms) {
      const termList = decodeURIComponent(terms)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (termList.length > 0) {
        const results = await Promise.all(
          termList.map(t =>
            yt.search(t, { type: 'video' }).then(r => r.videos || []).catch(() => [])
          )
        );
        const seen = new Set();
        return results
          .flat()
          .map(formatVideo)
          .filter(v => v && !seen.has(v.id) && seen.add(v.id))
          .sort(() => Math.random() - 0.5)
          .slice(0, 40);
      }
    }
    const feed = await yt.getHomeFeed();
    return (feed.videos || []).slice(0, 30).map(formatVideo).filter(Boolean);
  } catch (error) {
    console.error('Trending error:', error);
    return [];
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
