import type { NextFunction, Request, Response } from 'express';
import { promises as fs } from 'fs';
import mime from 'mime';
import path from 'path';

const isSafePublicPath = (root: string, filePath: string): boolean => {
  const relative = path.relative(root, filePath);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
};

export const sendPublicFile = async (
  root: string,
  relativePath: string,
  res: Response
): Promise<boolean> => {
  const filePath = path.join(root, relativePath);
  if (!isSafePublicPath(root, filePath)) {
    return false;
  }
  try {
    const data = await fs.readFile(filePath);
    const contentType = mime.getType(filePath) ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    if (relativePath === 'index.html') {
      res.setHeader('Cache-Control', 'no-store');
    } else if (
      relativePath.startsWith(`assets${path.sep}`) ||
      relativePath.startsWith('assets/')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    res.send(data);
    return true;
  } catch {
    return false;
  }
};

export const embeddedPublicStatic = (
  root: string
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const relativePath = decodeURIComponent(
      (req.path ?? '/').replace(/^\//, '')
    );
    if (!relativePath) {
      next();
      return;
    }
    void sendPublicFile(root, relativePath, res).then((sent) => {
      if (!sent) next();
    });
  };
};
