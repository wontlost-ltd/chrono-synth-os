import type { Migration } from '../../types.js';
import { desktop_v001 } from './v001.js';
import { desktop_v002 } from './v002.js';
import { desktop_v003 } from './v003.js';
import { desktop_v004 } from './v004.js';
import { desktop_v005 } from './v005.js';
import { desktop_v006 } from './v006.js';
import { desktop_v007 } from './v007.js';

export const DESKTOP_MIGRATIONS: readonly Migration[] = [
  desktop_v001,
  desktop_v002,
  desktop_v003,
  desktop_v004,
  desktop_v005,
  desktop_v006,
  desktop_v007,
];
