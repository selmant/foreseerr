import ImageProxy from '@server/lib/imageproxy';
import {
  resolveImageProxyFetch,
  type ImageProxySource,
} from '@server/lib/imageproxySources';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

const RATE_LIMIT = {
  maxRequests: 20,
  maxRPS: 50,
};

const proxies = new Map<ImageProxySource, ImageProxy>();

const SOURCE_BASE_URL: Record<ImageProxySource, string> = {
  tmdb: 'https://image.tmdb.org',
  tvdb: 'https://artworks.thetvdb.com',
  anilist: '',
  simkl: '',
};

function initImageProxy(source: ImageProxySource): ImageProxy {
  const existing = proxies.get(source);
  if (existing) return existing;
  const proxy = new ImageProxy(source, SOURCE_BASE_URL[source], {
    maxRedirects: 0,
    rateLimitOptions: RATE_LIMIT,
  });
  proxies.set(source, proxy);
  return proxy;
}

const requestPathForFetch = (
  source: ImageProxySource,
  fetchUrl: string,
  imagePath: string,
  search: string
): string => {
  if (source === 'tmdb' || source === 'tvdb') {
    return `${imagePath}${search}`;
  }
  return fetchUrl;
};

router.get<{
  type: string;
  path: string[];
}>('/:type/*path', async (req, res) => {
  const imagePath = '/' + req.params.path.join('/');
  const searchIndex = req.url.indexOf('?');
  const search = searchIndex === -1 ? '' : req.url.slice(searchIndex);

  if (imagePath.startsWith('//') || imagePath.includes('://')) {
    logger.error('Invalid URL for image proxy', { imagePath });
    return res.status(403).send('Invalid URL for image proxy');
  }

  const resolved = resolveImageProxyFetch(req.params.type, imagePath, search);
  if ('error' in resolved) {
    if (resolved.error === 'unsupported') {
      logger.error('Unsupported image type', {
        imagePath,
        type: req.params.type,
      });
      return res.status(400).send('Unsupported image type');
    }
    logger.error('Invalid URL for image proxy', { imagePath });
    return res.status(403).send('Invalid URL for image proxy');
  }

  try {
    const imageData = await initImageProxy(resolved.source).getImage(
      requestPathForFetch(resolved.source, resolved.fetchUrl, imagePath, search)
    );

    res.writeHead(200, {
      'Content-Type': `image/${imageData.meta.extension}`,
      'Content-Length': imageData.imageBuffer.length,
      'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    logger.error('Failed to proxy image', {
      imagePath,
      errorMessage: e.message,
    });
    res.status(500).send();
  }
});

export default router;
