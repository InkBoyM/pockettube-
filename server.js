import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Innertube, Platform } from 'youtubei.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: true });

// Provide JS evaluator using Function constructor (official method)
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

// Favicon
fastify.get('/favicon.ico', (req, reply) => reply.code(204).send());

// Search history storage (In-memory)
const searchHistory = new Set();
const watchHistory = [];

// Utility to format video data
const formatVideo = (v) => ({
  id: v.id?.toString() || v.video_id?.toString() || v.endpoint?.payload?.videoId || v.endpoint?.payload?.reelId,
  title: v.title?.text || v.title?.toString() || 'Unknown',
  author: v.author?.name || v.author?.toString() || 'Unknown',
  authorId: v.author?.id || v.author?.endpoint?.payload?.browseId,
  duration: v.duration?.text || 'N/A',
  durationSeconds: v.duration?.seconds || 0,
  thumbnail: v.thumbnails?.at(-1)?.url || v.thumbnail?.at(-1)?.url || '',
  isShort: v.type === 'ShortVideo' || (v.duration?.seconds || 0) <= 60 || v.endpoint?.payload?.reelId !== undefined
});

// API: Search
fastify.get('/api/search', async (request, reply) => {
  const { q } = request.query;
  if (!q) return reply.status(400).send({ error: 'Missing query parameter q' });
  try {
    // Add to search history (keep last 20 unique searches)
    searchHistory.delete(q);
    searchHistory.add(q);
    if (searchHistory.size > 20) {
      const firstEntry = searchHistory.values().next().value;
      searchHistory.delete(firstEntry);
    }

    const results = await yt.search(q, { type: 'video' });
    return results.videos.map(formatVideo);
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// API: Get Search History
fastify.get('/api/history', async () => Array.from(searchHistory).reverse());

// API: Video Watch History
fastify.get('/api/history/videos', async () => watchHistory.slice().reverse());

fastify.post('/api/history/watch', async (request) => {
  const video = request.body;
  if (!video || !video.id) return { success: false };
  
  // Remove duplicate if exists and push to top
  const index = watchHistory.findIndex(v => v.id === video.id);
  if (index !== -1) watchHistory.splice(index, 1);
  watchHistory.push(video);
  return { success: true };
});

// API: Stream Info
fastify.get('/api/stream/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    return {
      url: `/api/proxy/${id}`,
      title: info.basic_info.title,
      author: info.basic_info.author,
      description: info.basic_info.short_description?.slice(0, 300) || '',
      viewCount: info.basic_info.view_count,
      likeCount: info.basic_info.like_count
    };
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// API: Proxy Stream
fastify.get('/api/proxy/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const info = await yt.getInfo(id);
    let format;
    try {
      format = info.chooseFormat({ quality: '360p', type: 'video+audio' });
    } catch {
      format = info.chooseFormat({ type: 'video+audio' });
    }

    const streamUrl = await format.decipher(yt.session.player);
    console.log('Stream URL obtained, fetching... status will follow');

    const fetchHeaders = {
      'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
      'Accept': '*/*',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
    };
    if (request.headers['range']) fetchHeaders['Range'] = request.headers['range'];

    const response = await fetch(streamUrl, { headers: fetchHeaders });
    console.log('YouTube response status:', response.status);

    if (!response.ok && response.status !== 206) {
      return reply.status(502).send({ error: `YouTube returned ${response.status}` });
    }

    reply.code(response.status);
    reply.header('Content-Type', response.headers.get('content-type') || 'video/mp4');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Access-Control-Allow-Origin', '*');
    const contentRange = response.headers.get('content-range');
    if (contentRange) reply.header('Content-Range', contentRange);
    const contentLength = response.headers.get('content-length');
    if (contentLength) reply.header('Content-Length', contentLength);

    return reply.send(response.body);
  } catch (error) {
    fastify.log.error(`Proxy error for ${id}: ${error.message}`);
    console.error('FULL ERROR:', error);
    if (!reply.sent) return reply.status(500).send({ error: error.message });
  }
});

// API: Channel Profile
fastify.get('/api/channel/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const channel = await yt.getChannel(id);
    const videos = await channel.getVideos();
    return {
      title: channel.metadata.title,
      thumbnail: channel.metadata.thumbnail?.at(-1)?.url,
      subscribers: channel.metadata.subscriber_count,
      videos: videos.videos.map(formatVideo)
    };
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// API: Channel Shorts
fastify.get('/api/channel/:id/shorts', async (request, reply) => {
  const { id } = request.params;
  try {
    const channel = await yt.getChannel(id);
    const shorts = await channel.getShorts();
    return (shorts.videos || shorts.contents || []).map(formatVideo);
  } catch (error) {
    return [];
  }
});

// API: Global Shorts Feed
fastify.get('/api/shorts', async (request, reply) => {
  try {
    let shorts = await yt.getShorts();
    let contents = shorts.contents || [];

    // Fallback: If global shorts feed is empty, search for trending shorts
    if (contents.length === 0) {
      const search = await yt.search('#shorts', { type: 'video' });
      contents = (search.videos || []).filter(v => (v.duration?.seconds || 0) <= 60);
    }

    return contents.map(formatVideo);
  } catch (error) {
    // Second fallback: general search
    try {
      const search = await yt.search('shorts', { type: 'video' });
      return (search.videos || []).map(formatVideo);
    } catch { return []; }
  }
});

// API: Trending
fastify.get('/api/trending', async (request, reply) => {
  try {
    const historyArray = Array.from(searchHistory).slice(-3); // Combine last 3 searches
    if (historyArray.length > 0) {
      const searchPromises = historyArray.map(term => 
        yt.search(term).then(res => res.videos || []).catch(() => [])
      );
      
      const allResults = await Promise.all(searchPromises);
      const seenIds = new Set();
      
      // Merge and shuffle results
      const combined = allResults.flat()
        .filter(v => {
          const vid = v.id?.toString() || v.video_id?.toString();
          if (!vid || seenIds.has(vid)) return false;
          seenIds.add(vid);
          return true;
        })
        .sort(() => Math.random() - 0.5);

      return combined.slice(0, 40).map(formatVideo);
    }
    // Default to Home Feed if no history
    const feed = await yt.getHomeFeed();
    return (feed.videos || []).slice(0, 20).map(formatVideo);
  } catch (error) {
    console.error('Trending fetch error:', error);
    return [];
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();