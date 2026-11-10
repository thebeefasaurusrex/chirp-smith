#!/usr/bin/env node
import { sfx } from '../sound/cli.mjs';

try {
  process.exitCode = await sfx(process.argv.slice(2));
} catch (error) {
  console.error('ChirpSmith: ' + error.message);
  process.exitCode = 2;
}
