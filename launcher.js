#!/usr/bin/env node
function ignoreBrokenStdio(stream) {
  if (!stream || typeof stream.on !== 'function') {
    return;
  }
  stream.on('error', (error) => {
    if (
      error &&
      (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')
    ) {
      return;
    }
  });
}
ignoreBrokenStdio(process.stdout);
ignoreBrokenStdio(process.stderr);
import('./dist/launcher.js');
