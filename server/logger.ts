/* eslint-disable no-console */
import { configDirectory } from '@server/utils/runtimePaths';
import path from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

const hformat = winston.format.printf(
  ({ level, label, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]${
      label ? `[${label}]` : ''
    }: ${message} `;
    if (Object.keys(metadata).length > 0) {
      msg += JSON.stringify(metadata);
    }
    return msg;
  }
);

// A managed desktop child has a machine-readable stdout contract: its sole
// stdout record is readiness. All diagnostics, including normal Winston
// console output, must therefore go to stderr while durable logs use the
// explicitly-owned log directory.
const logDirectory = process.env.LOG_DIRECTORY
  ? process.env.LOG_DIRECTORY
  : path.join(configDirectory(), 'logs');

const seerrFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDirectory, 'seerr-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '7d',
  createSymlink: true,
  symlinkName: 'seerr.log',
});
const machineLogFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDirectory, '.machinelogs-%DATE%.json'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '1d',
  createSymlink: true,
  symlinkName: '.machinelogs.json',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
});

seerrFileTransport.on('error', (err) => {
  console.error('Error in seerr file transport:', err);
});

machineLogFileTransport.on('error', (err) => {
  console.error('Error in machine log file transport:', err);
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'debug',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.timestamp(),
    hformat
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels:
        process.env.FORESEERR_RUNTIME === 'desktop'
          ? ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']
          : ['error', 'warn'],
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.splat(),
        winston.format.timestamp(),
        hformat
      ),
    }),
    seerrFileTransport,
    machineLogFileTransport,
  ],
});

export default logger;
