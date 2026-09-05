import { configDirectory } from '@server/utils/runtimePaths';
import { accessSync, existsSync } from 'fs';

const CONFIG_PATH = configDirectory();

const DOCKER_PATH = `${CONFIG_PATH}/DOCKER`;

export const appDataStatus = (): boolean => {
  return !existsSync(DOCKER_PATH);
};

export const appDataPath = (): string => {
  return CONFIG_PATH;
};

export const appDataPermissions = (): boolean => {
  try {
    accessSync(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
};
